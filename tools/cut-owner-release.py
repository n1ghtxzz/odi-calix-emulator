#!/usr/bin/env python3
"""Assemble a personal release from a verified image, without flashing.

The input may contain an owner profile and a root password hash. The output
stays private. Public builds use image/build.sh with ROOT_PW=locked and no
owner profile. Only version/provenance metadata changes here.
"""
import argparse
import copy
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import tarfile
import tempfile
import time
import zlib

BASE_SHA256='01ccf6f35042b756a3cbfdf107607b075632a741681feee939f0f873eb486769'

def run(args,env=None):
    return subprocess.run(args,check=True,capture_output=True,text=True,timeout=90,env=env)

def inventory(root):
    result={}
    for parent,dirs,files in os.walk(root):
        for name in dirs+files:
            p=Path(parent)/name
            s=p.lstat()
            value=[stat.S_IFMT(s.st_mode),stat.S_IMODE(s.st_mode),s.st_uid,s.st_gid]
            if p.is_symlink():value.append(os.readlink(p))
            elif stat.S_ISREG(s.st_mode):value.append(hashlib.sha256(p.read_bytes()).hexdigest())
            elif stat.S_ISCHR(s.st_mode) or stat.S_ISBLK(s.st_mode):value.append(s.st_rdev)
            result[p.relative_to(root).as_posix()]=value
    return result

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--version',default='odi-calix-v1.0.0')
    p.add_argument('--source-commit',required=True)
    p.add_argument('--epoch',type=int,default=int(time.time()))
    a=p.parse_args()
    assert os.geteuid()==0, 'root is needed to preserve device nodes and ownership'
    assert re.fullmatch(r'[A-Za-z0-9._-]+',a.version)
    assert re.fullmatch(r'[0-9a-f]{40}',a.source_commit)
    assert hashlib.sha256(a.base.read_bytes()).hexdigest()==BASE_SHA256, 'unverified input image'
    repo=Path(__file__).resolve().parents[1]
    a.output.mkdir(parents=True,exist_ok=True)
    os.umask(0o077)
    work=Path(tempfile.mkdtemp(prefix='odi-owner-release-'))
    with tarfile.open(a.base) as archive:
        names=archive.getnames()
        assert names==['fwu.sh','fwu_ver','md5.txt','rootfs','uImage']
        parts={n:archive.extractfile(n).read() for n in names}
        members={n:copy.copy(archive.getmember(n)) for n in names}
    for line in parts['md5.txt'].decode().splitlines():
        digest,name=line.split()
        assert hashlib.md5(parts[name]).hexdigest()==digest
    fs=work/'input.rootfs'
    fs.write_bytes(parts['rootfs'])
    before,after=work/'before',work/'after'
    for directory in (before,after):run(['unsquashfs','-no-progress','-d',str(directory),str(fs)])
    original=inventory(before)
    for f in (repo/'web').iterdir():
        if f.is_file():assert f.read_bytes()==(before/'etc/confd'/f.name).read_bytes(), 'web assets differ from verified input'
    date=dt.datetime.fromtimestamp(a.epoch,dt.timezone.utc)
    (after/'etc/version').write_text(a.version+' -- '+date.strftime('%Y-%m-%d %H:%M:%S UTC')+'\n')
    build=(after/'etc/odi-build').read_text().replace('odi-calix-ui-r8-1-20261106',a.version)
    build=re.sub(r'(?m)^built=.*$', 'built='+date.strftime('%Y-%m-%dT%H:%MZ'),build)
    build+='\nsource_commit='+a.source_commit+'\nassembled_from_sha256='+BASE_SHA256+'\n'
    (after/'etc/odi-build').write_text(build)
    for name in ['etc/version','etc/odi-build']:os.utime(after/name,(a.epoch,a.epoch))
    current=inventory(after)
    changed=sorted(k for k in original.keys()|current.keys() if original.get(k)!=current.get(k))
    assert changed==['etc/odi-build','etc/version'], changed
    assert not (after/'etc/odi-profile').exists(), 'fresh owner config seed must not be added'
    packed=work/'release.rootfs'
    env=dict(os.environ,SOURCE_DATE_EPOCH=str(a.epoch))
    run(['mksquashfs',str(after),str(packed),'-comp','xz','-b','262144','-noappend','-no-progress','-processors','2'],env)
    verified=work/'verified'
    run(['unsquashfs','-no-progress','-d',str(verified),str(packed)])
    assert inventory(verified)==current
    kernel=parts['uImage']
    header=struct.unpack('>7I4B32s',kernel[:64])
    assert header[0]==0x27051956
    assert zlib.crc32(kernel[:4]+bytes(4)+kernel[8:64])&0xffffffff==header[1]
    assert zlib.crc32(kernel[64:])&0xffffffff==header[6]
    assert len(kernel)==64+header[3] and len(kernel)<=1359872
    final=dict(parts,rootfs=packed.read_bytes(),fwu_ver=(a.version+'\n').encode())
    assert len(final['rootfs'])<=2572288
    final['md5.txt']=''.join(hashlib.md5(final[name]).hexdigest()+'  '+name+'\n' for _,name in (s.split() for s in parts['md5.txt'].decode().splitlines())).encode()
    image=a.output/(a.version+'.private.tar')
    assert not image.exists(), 'refuse to replace a release artifact'
    with tarfile.open(image,'w',format=tarfile.USTAR_FORMAT) as archive:
        for name in names:
            member=members[name]
            member.size=len(final[name]);member.mtime=a.epoch
            archive.addfile(member,io.BytesIO(final[name]))
    with tarfile.open(image) as archive:
        assert archive.getnames()==names
        assert all(archive.extractfile(n).read()==final[n] for n in names)
    report={'version':a.version,'source_commit':a.source_commit,'base_image_sha256':BASE_SHA256,
        'image_sha256':hashlib.sha256(image.read_bytes()).hexdigest(),'image_md5':hashlib.md5(image.read_bytes()).hexdigest(),
        'image_bytes':image.stat().st_size,'rootfs_bytes':len(final['rootfs']),'kernel_bytes':len(kernel),
        'changed_rootfs_paths':changed,'all_other_files_modes_owners_and_links_unchanged':True,
        'kernel_and_flasher_unchanged':True,'web_assets_match_release_source':True,
        'private_owner_image':True,'hardware_tested':False,'agent_flashed_device':False}
    manifest=a.output/'image-verification.private.json'
    manifest.write_text(json.dumps(report,indent=2)+'\n')
    for f in (image,manifest):
        if os.environ.get('SUDO_UID'):os.chown(f,int(os.environ['SUDO_UID']),int(os.environ['SUDO_GID']))
    print(json.dumps(report,indent=2))

if __name__=='__main__':main()
