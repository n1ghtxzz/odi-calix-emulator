/* An optional, owner-supplied software MIB. Native entities always win.
 * No path in this module calls the driver, apply, exec or a flash writer.
 * The bounded binary file carries data, never executable code. */
#include "omcid.h"

#define EM_ROWS 1024
#define EM_ATTRS 16384
#define EM_BYTES 262144
#define EM_FILE "/etc/omci-emulation.bin"
#define EM_TABLE 1
#define EM_RO 2
#define EM_SECRET 4
#define EM_ASSUMED 8
#define EM_LOCAL 1

struct em_attr { uint32_t off; uint16_t width, len; uint8_t index, flags; };
struct em_row { uint16_t cls, inst, first, count, flags; uint8_t deleted; };
static struct em_row er[EM_ROWS];
static struct em_attr ea[EM_ATTRS];
static uint8_t eb[EM_BYTES];
static uint8_t initial[EM_BYTES];
static unsigned ern, ean, ebn;
static int enabled;
static int allow_assumed;

static int native(uint16_t cls, uint16_t inst)
{
	return instance_is_autonomous(cls, inst) || mib_find(cls, inst) != 0;
}

static uint32_t checksum(const uint8_t *p, unsigned n)
{
	uint32_t h = 2166136261u;
	for (unsigned i = 0; i < n; i++)
		h = (h ^ p[i]) * 16777619u;
	return h;
}

/* A bad or oversized file disables the complete overlay, never half of it.
 * The read is capped at EM_BYTES plus one overflow probe byte. */
void emul_load(void)
{
	long fd, n;
	unsigned used = 0, pos = 16, nr, na, attrs = 0;
	char mode[4] = {0};
	uint8_t overflow;

	enabled = 0;
	allow_assumed = 0;
	ern = ean = ebn = 0;
	getnext.primed = 0;
	if (cfg_odi_get(CFG_ODI_PATH, "OMCI_EMULATION", mode, sizeof mode) == 1 &&
	    mode[0] == '0')
		return;
	allow_assumed = mode[0] == '2';
	fd = sys_open(EM_FILE, O_RDONLY);
	if (fd < 0)
		return;
	while (used < EM_BYTES) {
		n = sys_read((int)fd, eb + used, EM_BYTES - used);
		if (n < 0) { sys_close((int)fd); goto bad; }
		if (!n)
			break;
		used += (unsigned)n;
	}
	n = sys_read((int)fd, &overflow, 1);
	sys_close((int)fd);
	if (n != 0 || used < 16 || eb[0] != 'O' || eb[1] != 'M' ||
	    eb[2] != 'E' || eb[3] != '1' || nl_get32(eb + 8) != used - 16 ||
	    nl_get32(eb + 12) != checksum(eb + 16, used - 16))
		goto bad;
	nr = nl_get16(eb + 4);
	na = nl_get16(eb + 6);
	if (!nr || nr > EM_ROWS || na > EM_ATTRS)
		goto bad;
	for (unsigned i = 0; i < nr; i++) {
		struct em_row *r = &er[i];
		unsigned last = 0;

		if (used - pos < 8)
			goto bad;
		r->cls = nl_get16(eb + pos);
		r->inst = nl_get16(eb + pos + 2);
		r->flags = nl_get16(eb + pos + 4);
		r->count = nl_get16(eb + pos + 6);
		r->first = (uint16_t)attrs;
		r->deleted = 0;
		pos += 8;
		if (!r->cls || r->flags & ~EM_LOCAL || r->count > 16 ||
		    attrs + r->count > na || (i && (r->cls < er[i-1].cls ||
		    (r->cls == er[i-1].cls && r->inst <= er[i-1].inst))))
			goto bad;
		for (unsigned j = 0; j < r->count; j++) {
			struct em_attr *a = &ea[attrs++];

			if (used - pos < 6)
				goto bad;
			a->index = eb[pos];
			a->flags = eb[pos + 1];
			a->width = nl_get16(eb + pos + 2);
			a->len = nl_get16(eb + pos + 4);
			pos += 6;
			a->off = pos;
			if (a->index <= last || a->index > 16 ||
			    a->flags & ~(EM_TABLE | EM_RO | EM_SECRET | EM_ASSUMED) ||
			    !a->width || a->width > 4096 || a->len > 4096 ||
			    a->len > used - pos ||
			    (!(a->flags & EM_TABLE) && a->len != a->width))
				goto bad;
			last = a->index;
			pos += a->len;
		}
	}
	if (pos != used || attrs != na)
		goto bad;
	ern = nr;
	ean = na;
	ebn = used;
	for (unsigned i = 0; i < used; i++) initial[i] = eb[i];
	enabled = 1;
	out_fmt("software MIB: %d entities, %d attributes; local inventory, private replies on demand; no extra upload\n",
		(long)ern, (long)ean);
	return;
bad:
	out("software MIB: invalid profile, overlay disabled\n");
}

static struct em_row *lookup(uint16_t cls, uint16_t inst, int deleted)
{
	if (!enabled)
		return 0;
	for (unsigned i = 0; i < ern; i++)
		if (er[i].cls == cls && er[i].inst == inst &&
		    (deleted || !er[i].deleted))
			return &er[i];
	return 0;
}

int emul_exists(uint16_t cls, uint16_t inst)
{
	return !native(cls, inst) && lookup(cls, inst, 0) != 0;
}

int emul_seed(uint16_t cls, uint16_t inst, unsigned k, uint8_t *out, unsigned width)
{
	struct em_row *r = lookup(cls, inst, 0);
	if (!r) return 0;
	for (unsigned j = 0; j < r->count; j++) {
		struct em_attr *a = &ea[r->first+j];
		if (a->index != k || a->width != width || a->len != width ||
		    (a->flags & EM_TABLE)) continue;
		for (unsigned b = 0; b < width; b++) out[b] = initial[a->off+b];
		return 1;
	}
	return 0;
}

static struct em_attr *attribute(struct em_row *r, unsigned index)
{
	for (unsigned j = 0; j < r->count; j++)
		if (ea[r->first + j].index == index &&
		    (allow_assumed || !(ea[r->first + j].flags & EM_ASSUMED)))
			return &ea[r->first + j];
	return 0;
}

int emul_has_class(uint16_t cls)
{
	for (unsigned i = 0; enabled && i < ern; i++)
		if (er[i].cls == cls)
			return 1;
	return 0;
}

/* An OLT Create of a native model still goes through the native handler.
 * Additional software-only instances clone a bounded template privately. */
static struct em_row *create(uint16_t cls, uint16_t inst)
{
	struct em_row *r = lookup(cls, inst, 1), *src = 0;
	unsigned bytes = 0;
	if (r) {
		for (unsigned j = 0; j < r->count; j++) {
			struct em_attr *a = &ea[r->first+j];
			for (unsigned b = 0; b < a->len; b++) eb[a->off+b] = initial[a->off+b];
		}
		r->deleted = 0;
		return r;
	}
	for (unsigned i = 0; i < ern; i++)
		if (er[i].cls == cls) { src = &er[i]; break; }
	if (!src || ern == EM_ROWS || ean + src->count > EM_ATTRS)
		return 0;
	for (unsigned j = 0; j < src->count; j++)
		bytes += ea[src->first + j].len;
	if (bytes > EM_BYTES - ebn)
		return 0;
	r = &er[ern++];
	*r = *src;
	r->inst = inst;
	r->first = (uint16_t)ean;
	r->deleted = 0;
	for (unsigned j = 0; j < src->count; j++) {
		struct em_attr *a = &ea[ean++];
		*a = ea[src->first + j];
		a->off = ebn;
		for (unsigned b = 0; b < a->len; b++) {
			initial[ebn] = initial[ea[src->first+j].off+b];
			eb[ebn] = initial[ebn];
			ebn++;
		}
	}
	return r;
}

int emul_handle(int fd, uint32_t tid, const uint8_t *f)
{
	uint16_t cls = nl_get16(f + 4), inst = nl_get16(f + 6);
	uint8_t mt = OMCI_MT(f[2]), body[32] = {0};
	struct em_row *r;
	uint16_t mask = nl_get16(f + 8), got = 0, bad = 0, failed = 0;
	unsigned n = 3;

	/* A captured, already-provisioned MIB is not a declaration of free
	 * hardware resources. Native classes and existing fixed replies are
	 * authoritative even when an instance has not been provisioned yet.
	 * Only unknown vendor classes can use the passive data model. */
	if (!enabled || cls < 0xff00 || find_class(cls) ||
	    fixed_me_per_inst(cls) || fixed_me_find(cls) ||
	    native(cls, inst) || !emul_has_class(cls))
		return 0;
	if (mt == OMCI_MT_MIB_UPLOAD || mt == OMCI_MT_MIB_UPLOAD_NEXT ||
	    mt == OMCI_MT_MIB_RESET || mt == OMCI_MT_GET_ALL_ALARMS ||
	    mt == OMCI_MT_GET_ALL_ALARMS_NEXT || mt == OMCI_MT_SYNC_TIME)
		return 0;
	if (!(f[2] & OMCI_AR))
		return 1;
	/* A native model may acquire a real service instance through Set,
	 * without any preceding Create (queues are one example). All native
	 * mutations keep their existing handler, even when the optional
	 * inventory had a software row at that id before provisioning. */
	if ((mt == OMCI_MT_CREATE || mt == OMCI_MT_SET || mt == OMCI_MT_DELETE) &&
	    find_class(cls))
		return 0;
	r = lookup(cls, inst, 0);
	if (mt == OMCI_MT_CREATE) {
		/* Preserve the existing unknown-ME compatibility policy. An
		 * inventory can include entities the OLT will create again;
		 * this must not turn a previously accepted provisioning step
		 * into instance-exists or an unsupported-create failure. */
		if (unknown_me_ok) {
			if (!r) r = create(cls, inst);
			if (!r) return 0;
			mib_data_sync++;
			goto answer;
		}
		if (r) { body[0] = OMCI_ERR_INST_EXISTS; goto answer; }
		/* The profile carries no vendor create-mask contract. Creating a
		 * row with attributes must be refused rather than guessed. */
		for (unsigned b = 8; b < 40; b++)
			if (f[b]) { body[0] = OMCI_ERR_NOT_SUPPORTED; goto answer; }
		r = create(cls, inst);
		if (!r) { body[0] = OMCI_ERR_CMD; goto answer; }
		mib_data_sync++;
		n = 3;
		goto answer;
	}
	if (!r) {
		if (unknown_me_ok) return 0;
		body[0] = OMCI_ERR_UNKNOWN_INST;
		goto answer;
	}
	if (mt == OMCI_MT_DELETE) {
		r->deleted = 1;
		mib_data_sync++;
		goto answer;
	}
	if (mt == OMCI_MT_GET_NEXT) {
		unsigned off = (unsigned)nl_get16(f + 10) * 29;
		if (!getnext.primed || getnext.classId != cls || getnext.inst != inst ||
		    getnext.attr < 1 || getnext.attr > 16 ||
		    (uint16_t)(1u << (16-getnext.attr)) != mask || off >= getnext.len) {
			body[0] = OMCI_ERR_BAD_PARAM;
			goto answer;
		}
		n = getnext.len - off;
		if (n > 29) n = 29;
		for (unsigned i = 0; i < n; i++) body[3 + i] = getnext.data[off + i];
		n += 3;
		nl_put16(body + 1, mask);
		goto answer;
	}
	if (mt == OMCI_MT_SET) {
		unsigned off = 10;
		/* Validate the entire packing before writing anything. */
		for (unsigned k = 1; k <= 16; k++) {
			struct em_attr *a;
			if (!(mask & (1u << (16-k)))) continue;
			a = attribute(r, k);
			if (!a || (a->flags & (EM_RO | EM_TABLE)) ||
			    a->width > 40 - off) {
				/* Let the old unknown-class handler acknowledge the
				 * write when that policy is explicitly enabled. It
				 * stores no guessed bytes and never reaches hardware. */
				if (unknown_me_ok && !find_class(cls)) return 0;
				body[0] = OMCI_ERR_NOT_SUPPORTED;
				goto answer;
			}
			off += a->width;
		}
		off = 10;
		for (unsigned k = 1; k <= 16; k++) {
			struct em_attr *a;
			if (!(mask & (1u << (16-k)))) continue;
			a = attribute(r, k);
			for (unsigned b = 0; b < a->width; b++) eb[a->off+b] = f[off++];
		}
		mib_data_sync++;
		goto answer;
	}
	if (mt != OMCI_MT_GET && mt != OMCI_MT_GET_CURRENT_DATA) {
		body[0] = OMCI_ERR_NOT_SUPPORTED;
		goto answer;
	}
	for (unsigned k = 1; k <= 16; k++) {
		struct em_attr *a;
		unsigned bit = 1u << (16-k);
		if (!(mask & bit)) continue;
		a = attribute(r, k);
		if (!a) { bad |= bit; continue; }
		if ((a->flags & EM_TABLE) || a->len > 25) {
			if (mask != bit) { failed |= bit; continue; }
			nl_put32(body + 3, a->len);
			nl_put16(body + 1, mask);
			n = 7;
			getnext.classId = cls; getnext.inst = inst; getnext.attr = (uint16_t)k;
			getnext.len = a->len; getnext.primed = 1;
			getnext.chunks = (uint16_t)((a->len+28)/29);
			for (unsigned b = 0; b < a->len; b++) getnext.data[b] = eb[a->off+b];
			goto answer;
		}
		if (failed || n + a->len > 28) { failed |= bit; continue; }
		for (unsigned b = 0; b < a->len; b++) body[n++] = eb[a->off+b];
		got |= bit;
	}
	nl_put16(body + 1, got);
	/* An attribute omitted from the captured schema must not introduce a
	 * new failure into an explicitly enabled compatibility policy. */
	if (bad && unknown_me_ok) return 0;
	if (bad || failed) {
		body[0] = OMCI_ERR_ATTR_FAILED;
		nl_put16(body + 28, bad); nl_put16(body + 30, failed);
		n = 32;
	}
answer:
	if (mt != OMCI_MT_GET && mt != OMCI_MT_GET_CURRENT_DATA &&
	    mt != OMCI_MT_GET_NEXT && mt != OMCI_MT_CREATE)
		n = 1;
	send_resp(fd, tid, f, body, (uint16_t)n);
	out_fmt("-> software MIB class %d inst %04x result %d (no hardware action)\n",
		(long)cls, (long)inst, (long)body[0]);
	return 1;
}

int emul_dump(uint16_t cls, int want_inst, uint16_t inst, int secrets)
{
	int count = 0;
	for (unsigned i = 0; enabled && i < ern; i++) {
		struct em_row *r = &er[i];
		if (r->deleted || (cls && cls != r->cls) ||
		    (want_inst && inst != r->inst)) continue;
		out_fmt("%d Emulated %d\n", (long)r->cls, (long)r->inst);
		for (unsigned j = 0; j < r->count; j++) {
			struct em_attr *a = &ea[r->first+j];
			if (!allow_assumed && (a->flags & EM_ASSUMED)) continue;
			out_fmt("    attr%d ", (long)a->index);
			if ((a->flags & EM_SECRET) && !secrets) out("**");
			else for (unsigned b = 0; b < a->len; b++) out_hex(eb[a->off+b], 2);
			out_char('\n');
		}
		count++;
	}
	return count;
}
