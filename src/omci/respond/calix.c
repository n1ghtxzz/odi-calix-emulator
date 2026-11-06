/* Optional, profile-scoped telemetry observed on the E7 line. The private
 * voice schemas are an interoperability model, not a SIP observer: calls
 * on a router behind the stick are not measured here. */
#include "omcid.h"
#define GET_VALUES_END 28u

#define A(name, type, width, access) { name, type, width, access, 0, 0, 1 }
#define U32(name) A(name, OMCI_U32, 4, 1)
#define U64(name) A(name, OMCI_U64, 8, 1)
#define ENTITY A("EntityID", OMCI_U16, 2, 1)
/* DateTime and TZoffset/DST packing is established by observed Sets. The
 * manufacturing string uses the twelve displayed ASCII bytes as an
 * explicit compatibility assumption until a wire Get is available. */
static const struct omci_attr info_attrs[] = {
	ENTITY, A("MfgSerialNumber", OMCI_OCTETS, 12, 1),
	A("DateTime", OMCI_U32, 4, 3), A("TelnetEnable", OMCI_U8, 1, 3),
	A("AuxPwrAdmin", OMCI_U8, 1, 3), A("AuxPwrStatus", OMCI_U8, 1, 3),
	A("OoklaPortId", OMCI_U16, 2, 3), A("OoklaDis", OMCI_U8, 1, 3),
	A("ProvCap", OMCI_U8, 1, 3), A("TodCap", OMCI_U8, 1, 3),
	A("TZoffset", OMCI_U32, 4, 3), A("DST", OMCI_U8, 1, 3),
	A("Pm64", OMCI_U8, 1, 3)
};
static const struct omci_attr pots_ext_attrs[] = {
	ENTITY, A("CallStatus", OMCI_U8, 1, 1)
};
static const struct omci_attr call_attrs[] = {
	ENTITY, U32("DhcpAttempts"), U32("DhcpAcks"), U32("DhcpNacks"),
	U32("RegAttempts"), U32("RegChallenges"), U32("RegRejects"),
	U32("RegGrants"), U32("InCallAttempts"), U32("InCallCompletions"),
	U32("InCallBusy"), U32("InCallPeerDisconnects"),
	U32("InCallOntDisconnects"), U32("OutCallAttempts"),
	U32("OutCallCompletions"), U32("OutCallBusy")
};
static const struct omci_attr call2_attrs[] = {
	ENTITY, U32("OutCallPeerDisconnects"), U32("OutCallOntDisconnects"),
	U32("E911CallAttempts"), U32("E911CallCompletions"), U32("E911CallBusy"),
	U32("E911CallPeerDisconnects"), U32("E911CallOnHooks"),
	U32("VmwiNotifyMsgsWaiting"), U32("VmwiNotifyNoMsgsWaiting"),
	U32("RtpPktsSent"), U32("RtpPktsRecv"), U32("RtpNullIPSent"),
	U32("RtpNullIPRecv"), U32("Ext2ActiveCallCntr")
};
static const struct omci_attr call3_attrs[] = {
	ENTITY, U32("RecvErrors"), U32("XmitErrors"),
	A("EncodeType", OMCI_U8, 1, 1), A("PacketSize", OMCI_U16, 2, 1),
	U32("MissingRtp"), U32("SequenceErr"), U32("DropOuts"),
	U32("UnderRuns"), U32("Listens"), U32("RecvBadSrcPorts"),
	U32("RecvComfortNoisePkts")
};
static const struct omci_attr call4_attrs[] = {
	ENTITY, A("LocalUdpPort", OMCI_U16, 2, 1), U32("RemIpAdd"),
	A("RemUdpPort", OMCI_U16, 2, 1), U32("SecRemIpAddr"),
	A("SecRemUdpPort", OMCI_U16, 2, 1), A("Qos", OMCI_U8, 1, 1),
	A("IpLineStatus", OMCI_U8, 1, 1), A("Active911Call", OMCI_U8, 1, 1),
	A("ClrErrorCntrs", OMCI_U8, 1, 3), A("ClrCallCntrs", OMCI_U8, 1, 3)
};
static const struct omci_attr eth_attrs[] = {
	ENTITY, A("IfCountReset", OMCI_U8, 1, 3), U32("IfInDiscards"),
	U32("IfInErrors"), U64("IfHCInOctets"), U64("IfHCInUcastPkts"),
	U64("IfHCInMcastPkts"), U64("IfHCInBcastPkts"), U64("IfHCOutOctets"),
	U64("IfHCOutUcastPkts"), U64("IfHCOutMcastPkts"), U64("IfHCOutBcastPkts"),
	U32("IfInRate"), U32("IfInMaxRate"), U32("IfOutRate"),
	U32("IfOutMaxRate"), U32("LastResetTime")
};
/* std bit 0x10 excludes these local telemetry rows from MIB upload. The
 * existing fixed 65311 upload records keep their order and contents. */
static const struct omci_class models[] = {
	{241, "Information", 32, info_attrs, 13, 0x300, 0x10, 0},
	{244, "PotsUniExt", 4, pots_ext_attrs, 2, 0x200, 0x10, 0},
	{65280, "CalixVoipCallStatistics", 62, call_attrs, 16, 0x300, 0x10, 0},
	{65281, "CalixVoipCallStatisticsExt2", 60, call2_attrs, 15, 0x300, 0x10, 0},
	{65282, "CalixVoipCallStatisticsExt3", 44, call3_attrs, 12, 0x300, 0x10, 0},
	{65283, "CalixVoipCallStatisticsExt4", 24, call4_attrs, 11, 0x300, 0x10, 0},
	{65311, "EthernetUniHCExt", 96, eth_attrs, 17, 0x300, 0x10, 0}
};

const char *calix_clock_path;
struct eth_sample {
	uint64_t raw[CALIX_COUNTERS], total[CALIX_COUNTERS], base[CALIX_COUNTERS];
	uint32_t rate[2], peak[2], reset_time;
	long sampled, attempted;
	int valid, tried;
};
static struct eth_sample eth;
static uint32_t logical_reset[4];

static unsigned logical_index(uint16_t inst)
{
	return inst == 0x0107 ? 3 : inst - 0x0102;
}

const struct omci_class *calix_class(uint16_t cls)
{
	if ((cls < 65280 || cls > 65283) && cls != 65311 && cls != 241 && cls != 244) return 0;
	if (!e7_profile()) return 0;
	for (unsigned i = 0; i < sizeof models / sizeof models[0]; i++)
		if (models[i].classId == cls) return &models[i];
	return 0;
}

static long now_seconds(void)
{
	long s = 0, ns = 0;
	if (calix_clock_path) {
		char b[24];
		long fd = sys_open(calix_clock_path, O_RDONLY), n;
		if (fd < 0) return -1;
		n = sys_read((int)fd, b, sizeof b);
		sys_close((int)fd);
		if (n <= 0 || n == (long)sizeof b) return -1;
		for (long i = 0; i < n && b[i] != '\n'; i++) {
			if (b[i] < '0' || b[i] > '9' || s > 200000000L) return -1;
			s = s * 10 + b[i] - '0';
		}
		return s;
	}
	return sys_clock_gettime(CLOCK_MONOTONIC, &s, &ns) == 0 ? s : -1;
}

/* Avoid a freestanding dependency on a 64-bit division runtime. */
static uint32_t rate_per_second(uint64_t delta, uint32_t seconds)
{
	uint64_t rem = 0, q = 0;
	if (!seconds) return 0;
	for (unsigned i = 0; i < 64; i++) {
		rem = (rem << 1) | (delta >> 63);
		delta <<= 1;
		q <<= 1;
		if (rem >= seconds) { rem -= seconds; q |= 1; }
	}
	return q > 0xffffffffu ? 0xffffffffu : (uint32_t)q;
}

void calix_tick(void)
{
	uint64_t v[CALIX_COUNTERS];
	long now;
	int port, restarted;
	if (!e7_profile() || !fixed_me_has_inst(65311, 0x0101)) return;
	now = now_seconds();
	if (now < 0 || (eth.tried && eth.attempted == now)) return;
	eth.attempted = now;
	eth.tried = 1;
	port = uni_switch_port(0x0101, 2);
	if (port < 0 || calix_port_read((unsigned)port, v) != 0) return;
	restarted = eth.valid && (v[2] < eth.raw[2] || v[6] < eth.raw[6] || now < eth.sampled);
	for (unsigned i = 0; i < CALIX_COUNTERS; i++) {
		uint64_t delta = v[i] - eth.raw[i];
		if (i != 2 && i != 6) delta = (uint32_t)delta;
		if (!eth.valid || restarted) {
			eth.total[i] = v[i];
			eth.base[i] = 0;
		} else eth.total[i] += delta;
		if (i == 2 || i == 6) {
			unsigned dir = i == 6;
			eth.rate[dir] = eth.valid && !restarted ?
				rate_per_second(delta, (uint32_t)(now - eth.sampled)) : 0;
			if (restarted) eth.peak[dir] = 0;
			if (eth.rate[dir] > eth.peak[dir]) eth.peak[dir] = eth.rate[dir];
		}
		eth.raw[i] = v[i];
	}
	if (restarted) eth.reset_time = (uint32_t)now;
	eth.sampled = now;
	eth.valid = 1;
}

static int exists(uint16_t cls, uint16_t inst)
{
	if (cls == 241) return inst == 0;
	if (cls == OMCI_ME_VOIP_CONFIG_DATA) return inst >= 1 && inst <= pots_ports;
	if (cls == 65311)
		return (inst >= 0x0101 && inst <= 0x0104 && fixed_me_has_inst(cls, inst)) ||
		       (inst == 0x0107 && e7_software_interface(cls, inst));
	return (inst >> 8) == pots_slot && (inst & 255) >= 1 &&
	       (inst & 255) <= pots_ports;
}

/* This local anchor is in unused, snapshotted row bytes, outside every
 * Information wire attribute. It never sets the system or NTP clock. */
#define INFO_TIME_ANCHOR 92
static uint32_t stored_u32(const struct mib_row *r, unsigned off)
{
	uint32_t v = 0;
	for (unsigned i = 0; i < 4; i++) v = (v << 8) | row_get(r, off+i);
	return v;
}

static int config_alias(uint16_t cls, uint16_t inst)
{
	return cls == OMCI_ME_VOIP_CONFIG_DATA && inst != 0 && e7_profile() && pots_ports;
}

static int stored_value(const struct omci_class *c, uint16_t inst, unsigned k,
			uint8_t *out, unsigned w)
{
	const struct mib_row *r = mib_find(c->classId, inst);
	int off = attr_offset(c, k);
	if (!r || !(r->written & (1u << (16-k))) || off < 0 ||
	    (unsigned)off+w > row_cap(r)) return 0;
	for (unsigned b = 0; b < w; b++) out[b] = row_get(r, (unsigned)off+b);
	return 1;
}

/* 1: answered, -1: hardware sample unavailable. Only this profile can call
 * this function; missing physical samples are failures, not fake zeroes. */
int calix_attr(uint16_t cls, uint16_t inst, unsigned k, uint8_t *out)
{
	const struct omci_class *c = calix_class(cls);
	uint64_t value = 0;
	unsigned w;
	long now;
	if (!c && config_alias(cls, inst)) c = find_class(cls);
	if (!c || !exists(cls, inst) || !k || k >= c->nattr) return -1;
	w = attr_width(c, k);
	for (unsigned b = 0; b < w; b++) out[b] = 0;
	if (cls == 241) {
		const struct mib_row *r = mib_find(cls, inst);
		if (k == 2) {
			long ns = 0;
			uint32_t anchor = r ? stored_u32(r, INFO_TIME_ANCHOR) : 0;
			now = now_seconds();
			if (r && (r->written & 0x4000)) {
				value = row_u32(r, c, 2);
				if (now >= 0 && (uint32_t)now >= anchor) value += (uint32_t)now-anchor;
			} else if (sys_clock_gettime(CLOCK_REALTIME, &now, &ns) == 0 && now > 0)
				value = (uint32_t)now;
		} else if (stored_value(c, inst, k, out, w) || emul_seed(cls, inst, k, out, w))
			return 1;
		else if (k == 7) value = 2;
		else if (k == 8 || k == 9) value = 1;
	} else if (cls == 244) value = 1; /* idle, as observed on the phone UNI */
	else if (cls == OMCI_ME_VOIP_CONFIG_DATA) {
		if (stored_value(c, inst, k, out, w)) {
			/* Zero selects the available protocol automatically. */
			if (k == 2 && out[0] == 0) out[0] = 1;
			return 1;
		}
		if (k == 1 || k == 2 || k == 6) value = 1;
		else if (k == 3) value = 7;
		else if (k == 5) value = 0xffff;
		else if (k == 8) { if (w) out[0] = '0'; return 1; }
	} else if (cls != 65311) {
		/* No SIP or RTP terminates on this ONU. The router may report
		 * its registration through the existing class 141 interface;
		 * that is not a source of per-call packet statistics. */
		if (cls == 65283 && k == 6) value = 46;
	} else if (inst != 0x0101) {
		if (k == 16) value = logical_reset[logical_index(inst)];
	} else {
		calix_tick();
		now = now_seconds();
		if (k != 1 && k != 16 &&
		    (!eth.valid || now < eth.sampled || now - eth.sampled > 2)) return -1;
		if (k >= 2 && k <= 11) value = eth.total[k-2] - eth.base[k-2];
		else if (k >= 12 && k <= 15) {
			unsigned dir = k >= 14;
			value = (k & 1) ? eth.peak[dir] : eth.rate[dir];
		} else if (k == 16) value = eth.reset_time;
	}
	for (unsigned b = 0; b < w; b++) { out[w-1-b] = (uint8_t)value; value >>= 8; }
	return 1;
}

static int reset_eth(uint16_t inst)
{
	long now = now_seconds();
	if (now < 0) return -1;
	if (inst != 0x0101) { logical_reset[logical_index(inst)] = (uint32_t)now; return 0; }
	calix_tick();
	if (!eth.valid || now < eth.sampled || now - eth.sampled > 2) return -1;
	for (unsigned i = 0; i < CALIX_COUNTERS; i++) eth.base[i] = eth.total[i];
	for (unsigned i = 0; i < 2; i++) eth.rate[i] = eth.peak[i] = 0;
	eth.reset_time = (uint32_t)now;
	return 0;
}

int calix_handle(int fd, uint32_t tid, const uint8_t *f)
{
	uint16_t cls = nl_get16(f+4), inst = nl_get16(f+6), mask = nl_get16(f+8);
	const struct omci_class *c = calix_class(cls);
	uint8_t mt = OMCI_MT(f[2]), body[32] = {0};
	uint16_t got = 0, unsupported = 0, failed = 0, n = 3;
	if (!c && config_alias(cls, inst)) c = find_class(cls);
	if (!c) return 0;
	if (!(f[2] & OMCI_AR)) return 1;
	if (!exists(cls, inst)) { body[0] = OMCI_ERR_UNKNOWN_INST; n = 1; goto answer; }
	if (mt == OMCI_MT_GET || mt == OMCI_MT_GET_CURRENT_DATA) {
		for (unsigned k = 1; k <= 16; k++) {
			uint16_t bit = (uint16_t)(1u << (16-k));
			unsigned w;
			if (!(mask & bit)) continue;
			if (k >= c->nattr) { unsupported |= bit; continue; }
			w = attr_width(c, k);
			if (failed || n+w > GET_VALUES_END || calix_attr(cls, inst, k, body+n) < 0) {
				failed |= bit; continue;
			}
			got |= bit; n = (uint16_t)(n+w);
		}
		nl_put16(body+1, got);
		if (unsupported || failed) {
			body[0] = OMCI_ERR_ATTR_FAILED;
			nl_put16(body+28, unsupported); nl_put16(body+30, failed); n = 32;
		}
	} else if (mt == OMCI_MT_SET) {
		unsigned off = 10;
		int reset = 0;
		int store = cls == 241 || cls == OMCI_ME_VOIP_CONFIG_DATA;
		/* A rejected attribute must not trigger even a local reset. */
		for (unsigned k = 1; k <= 16; k++) {
			uint16_t bit = (uint16_t)(1u << (16-k));
			unsigned w;
			if (!(mask & bit)) continue;
			w = k < c->nattr ? attr_width(c, k) : 0;
			if (!w || off+w > 40) { failed |= bit; break; }
			if (!(c->attrs[k].oltAcc & 2) || (!store && f[off] > 1)) failed |= bit;
			else if (cls == OMCI_ME_VOIP_CONFIG_DATA &&
			         ((k == 2 && f[off] > 1) || (k == 4 && f[off] > 1) ||
			          (k == 7 && f[off] != 0))) failed |= bit;
			else if (cls == 65311 && k == 1 && f[off]) reset = 1;
			off += w;
		}
		if (!failed && store) {
			struct mib_row *r = mib_add(cls, inst);
			if (!r) { body[0] = OMCI_ERR_CMD; n = 1; goto answer; }
			mib_write(r, c, mask, 0, f+10, 30);
			if (cls == 241 && (mask & 0x4000)) {
				long now = now_seconds();
				uint8_t anchor[4];
				nl_put32(anchor, now >= 0 ? (uint32_t)now : 0);
				for (unsigned b = 0; b < 4; b++) row_put(r, INFO_TIME_ANCHOR+b, anchor[b]);
			}
		}
		if (!failed && reset && reset_eth(inst) != 0) failed = mask;
		body[0] = failed ? OMCI_ERR_ATTR_FAILED : OMCI_OK;
		nl_put16(body+1, 0); nl_put16(body+3, failed); n = failed ? 5 : 1;
		if (!failed) {
			mib_data_sync++;
			if (store) snapshot_save();
		}
	} else { body[0] = OMCI_ERR_NOT_SUPPORTED; n = 1; }
answer:
	send_resp(fd, tid, f, body, n);
	out_fmt("-> Calix telemetry class %d inst %04x result %d mask %04x\n",
		(long)cls, (long)inst, (long)body[0], (long)(mt == OMCI_MT_SET ? mask : got));
	return 1;
}
