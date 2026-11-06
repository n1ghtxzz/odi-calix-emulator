#!/bin/bash
# Compile the actual bounded reader and fixed-entity parser for the host.
# No target image, device, privileged service or cross compiler is needed.
set -eu
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
python3 - "$scratch/check.c" <<'PY'
from pathlib import Path
import re
import sys
s = Path('src/omci/respond/cfgstore.c').read_text()
h = Path('src/omci/respond/omcid.h').read_text()
reader = s[s.index('static char odibuf['):s.index('/* Replace one key', s.index('static char odibuf['))]
parser = s[s.index('static int fixed_me_hex'):s.index('/* The any-instance entry')]
defs = '\n'.join(re.findall(r'^#define FIXED_ME_(?:MAX|ENTRIES)\s+\d+.*$', h, re.M))
structs = h[h.index('struct fixed_me {'):h.index('extern struct fixed_me_set fixed_me;')]
prefix = r'''
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
static char test_path[512];
#define CFG_ODI_PATH test_path
static int str_len(const char *p) { return (int)strlen(p); }
static long sys_open(const char *p, int f) { return open(p, f); }
static long sys_read(int f, void *p, unsigned long n) { return read(f, p, n); }
static long sys_close(int f) { return close(f); }
static int hex_nib(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
'''
main = r'''
static void load(const char *value, unsigned padding, unsigned expected) {
    FILE *f = fopen(test_path, "w");
    if (!f) abort();
    for (unsigned i = 0; i < padding; i++) fputc('#', f);
    fputs("\nOMCI_FIXED_ME=", f);
    fputs(value, f);
    fputc('\n', f);
    fclose(f);
    cfg_load_fixed_me();
    if (fixed_me.n != expected) {
        fprintf(stderr, "expected %u entries, got %u\n", expected, fixed_me.n);
        abort();
    }
}
int main(int argc, char **argv) {
    char value[12000];
    unsigned used = 0;
    if (argc != 2 || strlen(argv[1]) >= sizeof test_path) return 2;
    strcpy(test_path, argv[1]);
    if (FIXED_ME_ENTRIES != 128 || sizeof odibuf < 16384) return 3;
    /* Maximum-width values across several instances, not one repeated slot. */
    for (unsigned i = 0; i < FIXED_ME_ENTRIES; i++)
        used += (unsigned)snprintf(value + used, sizeof value - used,
                "62000:%u:1:00112233445566778899aabbccddeeff001122334455667788 ", i);
    load(value, 3000, 128);
    if (fixed_me.e[127].inst != 127 || fixed_me.e[127].len != 25 ||
        fixed_me.e[127].data[24] != 0x88) abort();
    puts("ok 128 entries after 3000 bytes of preceding config");
    strcpy(value + used, "62000:128:1:00");
    load(value, 0, 0);
    puts("ok 129th entry rejects the whole profile");
    value[used] = 0;
    strcpy(value + used, "62000:0:1:00");
    load(value, 0, 0);
    puts("ok duplicate beyond entry 16 rejects the whole profile");
    load("62000:1:1:00 62000:2:1:01 62001:1:3:02", 0, 3);
    puts("ok same attribute on different entities and classes");
    load("62000:1:1:00 62000:01", 0, 0);
    puts("ok mixed forms reject the whole profile");
    load("62000:1:17:00", 0, 0);
    load("62000:1:1:00112233445566778899aabbccddeeff00112233445566778899", 0, 0);
    puts("ok attribute and value width limits");
    load("62000:1:1:00", 16400, 0);
    puts("ok a key beyond the bounded file read is absent");
    load("62000:1:1:00", 0, 1);
    unlink(test_path);
    return 0;
}
'''
Path(sys.argv[1]).write_text(prefix + defs + '\n' + structs + '\nstruct fixed_me_set fixed_me;\n' + reader + parser + main)
PY
# ODI_SAN_CFLAGS is shared with the existing host sanitizer test leg.
cc -std=c11 -Wall -Wextra -Werror ${ODI_SAN_CFLAGS-} "$scratch/check.c" -o "$scratch/check"
"$scratch/check" "$scratch/odi.conf"
