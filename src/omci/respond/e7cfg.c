/* E7 provisioning state and software interfaces. No driver calls. */
#include "omcid.h"

#define A(name, type, width, access, option) \
	{ name, type, width, access, 0, 0, option }
#define ENTITY A("EntityID", OMCI_U16, 2, 5, OMCI_OPT_MANDATORY)
#define U16(name, access) A(name, OMCI_U16, 2, access, OMCI_OPT_MANDATORY)
#define U8(name, access) A(name, OMCI_U8, 1, access, OMCI_OPT_MANDATORY)

/* Scalar widths follow the observed CLI and Set masks. No populated
 * static/dynamic-IP table format has been established: both tables are
 * empty and read-only, rather than accepting guessed opaque entries. */
static const struct omci_attr uni_ext[] = {
	ENTITY, U16("Opt60ProfPtr", 3), U16("Opt60Tpid", 3),
	U16("Opt60Tci", 3), U16("StaticIpTableSize", 1),
	A("StaticIpTableEntry", OMCI_OCTETS, 4, 1, OMCI_OPT_TABLE),
	U16("MvrVlan", 3), U16("DhcpLeaseLimit", 3),
	U16("SourceMacLimit", 3),
	A("SMacAge", OMCI_U32, 4, 3, OMCI_OPT_MANDATORY),
	U8("L2cpBridgeBlock", 3), U8("L2cpGarp", 3), U8("L2cpAllLans", 3),
	U16("DynamicIpTableSize", 1),
	A("DynamicIpTableEntry", OMCI_OCTETS, 4, 1, OMCI_OPT_TABLE),
	U8("IngressPolicing", 3), U8("IngressPolicingMap", 3)
};

/* Public G.988 SIP agent config data 2. The timers describe the requested
 * SIP policy; an external SIP client is not reconfigured by these rows. */
static const struct omci_attr sip_agent2[] = {
	ENTITY, U16("InUseOptionsTimer", 7), U16("AlternateOptionsTimer", 7),
	U8("Revertive", 7),
	A("CurrentProxyServerResolvedAddress", OMCI_U32, 4, 1, OMCI_OPT_OPTIONAL),
	A("CurrentProxyServerResolvedName", OMCI_U16, 2, 1, OMCI_OPT_OPTIONAL),
	A("AlternateProxyServerResolvedAddress", OMCI_U32, 4, 1, OMCI_OPT_OPTIONAL),
	A("AlternateProxyServerResolvedName", OMCI_U16, 2, 1, OMCI_OPT_OPTIONAL)
};
static const struct omci_class config_models[] = {
	{251, "EthernetUniExtConfig", 40, uni_ext, 17, 0x14000350u, 0x001, 1},
	{407, "SipAgentConfigData2", 20, sip_agent2, 8, 0x10000350u, 0x001, 1}
};

const struct omci_class *e7_config_class(uint16_t cls)
{
	if (!e7_profile()) return 0;
	for (unsigned i = 0; i < sizeof config_models / sizeof config_models[0]; i++)
		if (config_models[i].classId == cls) return &config_models[i];
	return 0;
}

/* Valid operations go through the ordinary native store: writes, readback,
 * snapshots, duplicate transactions, deletion and upload share one state. */
int e7_config_guard(int fd, uint32_t tid, const uint8_t *f)
{
	uint16_t cls = nl_get16(f + 4), inst = nl_get16(f + 6);
	const struct omci_class *c = e7_config_class(cls);
	uint8_t mt = OMCI_MT(f[2]), body[5] = {0};
	unsigned n = 1;
	if (!c) return 0;
	if (!(c->actions & (1u << mt))) body[0] = OMCI_ERR_NOT_SUPPORTED;
	else if (mt != OMCI_MT_CREATE && !mib_find(cls, inst))
		body[0] = OMCI_ERR_UNKNOWN_INST;
	else if (cls == 251 && mt == OMCI_MT_CREATE) {
		/* The observed constructor has no nonzero creation data. */
		for (unsigned i = 8; i < 40; i++)
			if (f[i]) body[0] = OMCI_ERR_NOT_SUPPORTED;
	} else if (cls == 407 && (mt == OMCI_MT_CREATE || mt == OMCI_MT_SET)) {
		uint16_t mask = mt == OMCI_MT_CREATE ? create_mask(c) : nl_get16(f + 8);
		unsigned off = mt == OMCI_MT_CREATE ? 8 : 10;
		for (unsigned k = 1; k <= 3; k++) {
			if (!(mask & (1u << (16 - k)))) continue;
			if (k == 3 && f[off] > 1) {
				body[0] = OMCI_ERR_ATTR_FAILED;
				nl_put16(body + (mt == OMCI_MT_CREATE ? 1 : 3), 0x2000);
				n = mt == OMCI_MT_CREATE ? 3 : 5;
			}
			off += attr_width(c, k);
		}
	}
	if (!body[0]) return 0;
	send_resp(fd, tid, f, body, (uint16_t)n);
	out_fmt("-> E7 config class %d inst %04x result %d\n",
		(long)cls, (long)inst, (long)body[0]);
	return 1;
}

/* Respect OMCI_VEIP=0. These extra logical interfaces belong to the
 * configured VEIP slot; none owns an additional physical switch lane. */
int e7_software_interface(uint16_t cls, uint16_t inst)
{
	if (!e7_profile() || !veip_on) return 0;
	if (inst == 0x0107)
		return cls == OMCI_ME_PPTP_ETH_UNI || cls == OMCI_ME_UNI_G ||
		       cls == 65319 || cls == 65311;
	return inst == (uint16_t)(veip_slot << 8 | 2) &&
	       (cls == OMCI_ME_VEIP || cls == OMCI_ME_TR069_MGMT_SERVER);
}

/* Called after native stored values, so an accepted Set still reads back.
 * State without a physical WLAN stays down; VEIP state follows its own
 * administrative value, without changing the physical PON or host port. */
int e7_software_value(const struct omci_class *c, uint16_t inst,
		      unsigned k, uint8_t *out, uint16_t n)
{
	uint16_t cls = c->classId, seed_inst = inst;
	uint32_t value = 0;
	if (!e7_software_interface(cls, inst) || cls == 65311) return 0;
	if (cls == OMCI_ME_VEIP || cls == OMCI_ME_TR069_MGMT_SERVER)
		seed_inst = 0x0302;
	if (cls == OMCI_ME_PPTP_ETH_UNI && (k == 6 || k == 7))
		value = k == 6;
	else if (cls == OMCI_ME_UNI_G && k == 4)
		value = (uint16_t)(veip_slot << 8 | 2);
	else if (cls == OMCI_ME_VEIP && k == 2) {
		const struct mib_row *r = mib_find(cls, inst);
		uint8_t admin[1] = {0};
		if (r && (r->written & 0x8000)) value = row_u32(r, c, 1) != 0;
		else if (emul_seed(cls, seed_inst, 1, admin, 1)) value = admin[0] != 0;
	} else if (emul_seed(cls, seed_inst, k, out, n)) return 1;
	else if (cls == OMCI_ME_PPTP_ETH_UNI) {
		if (k == 1 || k == 2) value = 0x28;
		else if (k == 8) value = 1518;
		else if (k == 11) value = 2;
		else if (k == 13) value = 60;
	} else if (cls == OMCI_ME_UNI_G) {
		if (k == 1) value = 14;
		else if (k == 3) value = 2;
	} else if (cls == 65319) value = k == 2 || k == 3;
	else if (cls == OMCI_ME_VEIP && (k == 4 || k == 5)) value = 0xffff;
	else if (cls == OMCI_ME_TR069_MGMT_SERVER) value = k == 1 ? 1 : 0xffff;
	for (unsigned i = 0; i < n; i++) { out[n - i - 1] = (uint8_t)value; value >>= 8; }
	return 1;
}

/* A bounded trace of exact, serialized diagnostic replies. Only known
 * non-credential masks are selected; no arbitrary request or SIP password
 * is logged. At most 512 frames, less than 64 KiB, per daemon lifetime. */
void e7_diag_reply(const uint8_t *req, const uint8_t *reply)
{
	static unsigned count;
	uint16_t cls = nl_get16(req + 4), mask = nl_get16(req + 8);
	uint8_t mt = OMCI_MT(req[2]);
	int selected = 0;
	if (count >= 512 || (mt != OMCI_MT_GET && mt != OMCI_MT_GET_CURRENT_DATA) ||
	    !e7_profile()) return;
	if (cls == 257) selected = mask == 0x0040;
	else if (cls == 263) selected = mask == 0x004c;
	else if (cls == 11) selected = mask == 0xf600;
	else if (cls == 65311)
		selected = mask == 0x7800 || mask == 0x0700 || mask == 0x00e0 || mask == 0x001e;
	else if (cls == 65319) selected = mask == 0xa000;
	else if (cls == 138) selected = mask == 0x4400;
	else if (cls == 141) selected = mask == 0x4000;
	else if (cls == 53) selected = mask == 0x0040;
	else if (cls == 134) selected = mask == 0x40e0;
	else if (cls == 150) selected = mask == 0x0080;
	else if (cls == 244) selected = mask == 0x8000;
	else if (cls == 65280 || cls == 65281) selected = mask == 0xfc00;
	else if (cls == 65282) selected = mask == 0xfe00;
	else if (cls == 65283) selected = mask == 0xff00;
	else if (cls == 251) selected = mask == 0x07f2 || mask == 0x0001;
	else if (cls == 407) selected = mask == 0xe000;
	if (!selected) return;
	count++;
	out("diag-reply ");
	for (unsigned i = 0; i < OMCI_FRAME_LEN; i++) out_hex(reply[i], 2);
	out_char('\n');
	if (count == 512) out("diag-trace budget exhausted (512 replies)\n");
}
