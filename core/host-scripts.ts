// Root copies each input into its own private directory, checks those bytes, then runs only from that copy.
export const HOST_ROOT_STEP = String.raw`
import os, sys, json, tempfile, shutil, hashlib, subprocess

checks = json.loads(sys.argv[1])
root = tempfile.mkdtemp(prefix='paddock-root-')
try:
    copies = {}
    for source, checksum in checks.items():
        target = os.path.join(root, str(len(copies)))
        with open(source, 'rb') as incoming, open(target, 'xb') as outgoing:
            shutil.copyfileobj(incoming, outgoing)
        if hashlib.sha256(open(target, 'rb').read()).hexdigest() != checksum:
            raise RuntimeError('Staged file checksum mismatch; nothing installed by this step')
        copies[source] = target
    subprocess.run([copies.get(arg, arg) for arg in sys.argv[2:]], check=True)
finally:
    shutil.rmtree(root)
`

// Bootstrap uses Python already on the destination. No shell interprets a package, path or argument from a plan.

// Reads the destination without changing it and without sudo. The request on stdin names the artifact digest and the
// runtime's files, so the probe knows which release paths to inspect. Prints one JSON object.
export const HOST_PROBE = String.raw`
import os, sys, json, subprocess, hashlib, platform, pwd, grp, glob, shlex, stat, urllib.parse, re

request = json.load(sys.stdin)

def command(argv):
    try:
        p = subprocess.run(argv, text=True, capture_output=True, timeout=30)
        return dict(code=p.returncode, out=p.stdout.strip(), err=p.stderr.strip())
    except (OSError, subprocess.TimeoutExpired) as e:
        return dict(code=127, out='', err=str(e))

def file(path):
    try:
        s = os.lstat(path)
        if stat.S_ISLNK(s.st_mode):
            return dict(kind='link', target=os.readlink(path), uid=s.st_uid, mode=stat.S_IMODE(s.st_mode))
        if not stat.S_ISREG(s.st_mode):
            return dict(kind='other', uid=s.st_uid, mode=stat.S_IMODE(s.st_mode))
        h = hashlib.sha256()
        h512 = hashlib.sha512()
        with open(path, 'rb') as source:
            while True:
                data = source.read(1024 * 1024)
                if not data:
                    break
                h.update(data)
                h512.update(data)
        text = None
        if path.endswith(('.json', '.service', '/machine-id')):
            if s.st_size > 8 * 1024 * 1024:
                raise ValueError('text file exceeds 8 MiB')
            text = open(path).read()
        return dict(kind='file', sha256=h.hexdigest(), sha512=h512.hexdigest(), text=text, uid=s.st_uid, mode=stat.S_IMODE(s.st_mode))
    except FileNotFoundError:
        return dict(kind='absent')
    except (OSError, ValueError) as e:
        return dict(kind='unreadable', error=str(e))

uid = os.getuid()
account = pwd.getpwuid(uid)
state = '/var/lib/paddock/' + str(uid)
release = '/opt/paddock/releases/' + request['sha256'] + '/paddock'
paths = [
    '/etc/docker/daemon.json',
    '/usr/local/bin/paddock',
    '/etc/systemd/system/paddock@' + str(uid) + '.service',
    release,
    state + '/machine-id',
] + request['runtimeFiles']

# Include ancestors: replacing a root path through a link must not escape the reviewed installation layout.
ancestors = {}
for path in paths + [state]:
    parent = os.path.dirname(path)
    while parent != '/':
        if parent not in ancestors:
            try:
                s = os.lstat(parent)
                ancestors[parent] = dict(uid=s.st_uid, mode=stat.S_IMODE(s.st_mode), link=stat.S_ISLNK(s.st_mode))
            except FileNotFoundError:
                ancestors[parent] = None
        parent = os.path.dirname(parent)

os_release = {}
for line in open('/etc/os-release'):
    if '=' in line:
        k, v = line.rstrip().split('=', 1)
        os_release[k] = v.strip('"')

# Only fields that stay the same between two probes are kept, so an unchanged engine gives an unchanged plan. Of each
# runtime Docker has loaded, that is its path and arguments.
info = command(['docker', '--host', 'unix:///var/run/docker.sock', 'info', '--format', '{{json .}}'])
if info['code'] == 0:
    full = json.loads(info['out'])
    kept = {k: full.get(k) for k in ['ID', 'ServerVersion', 'Architecture', 'DockerRootDir', 'Driver', 'LiveRestoreEnabled']}
    kept['Runtimes'] = {name: {k: entry.get(k) for k in ['path', 'runtimeArgs']} for name, entry in (full.get('Runtimes') or {}).items()}
    info['out'] = json.dumps(kept, sort_keys=True)
containers = command(['docker', '--host', 'unix:///var/run/docker.sock', 'ps', '--no-trunc', '--format', '{{json .}}'])
if containers['code'] == 0:
    rows = [{k: v[k] for k in ['ID', 'Names', 'Image', 'Labels']} for v in map(json.loads, filter(None, containers['out'].splitlines()))]
    containers['out'] = '\n'.join(json.dumps(row, sort_keys=True) for row in sorted(rows, key=lambda row: row['ID']))

# Where Docker is absent, apt says which packages installing it would download, and the apt sources, keys and indexes
# that answer came from are recorded. Nothing is downloaded or locked. Where Docker is present, apt is not consulted.
absent = command(['which', 'docker'])['code'] != 0
packages = dict(code=0, out='', err='')
if absent:
    packages = command(['apt-get', '-qq', '--print-uris', '--yes', '--no-install-recommends', '-o', 'Debug::NoLocking=1', 'install', 'docker.io'])
downloads = []
for line in packages['out'].splitlines():
    if line.startswith("'"):
        words = shlex.split(line)
        fields = urllib.parse.unquote(words[1]).split('_')
        metadata = command(['apt-cache', 'show', fields[0] + '=' + fields[1]])
        sha = next((l[8:] for l in metadata['out'].splitlines() if l.startswith('SHA256: ')), '')
        downloads.append(dict(url=words[0], file=words[1], bytes=words[2], sha256=sha, package=fields[0], version=fields[1]))
apt = {}
repositories = {}
sources = glob.glob('/etc/apt/sources.list') + glob.glob('/etc/apt/sources.list.d/*') if absent else []
evidence = (
    sources + glob.glob('/var/lib/apt/lists/*') + glob.glob('/etc/apt/trusted.gpg')
    + glob.glob('/etc/apt/trusted.gpg.d/*') + glob.glob('/usr/share/keyrings/*')) if absent else []
for path in sorted(sources):
    if os.path.isfile(path):
        content = open(path).read()
        def clean_url(match):
            value = urllib.parse.urlsplit(match.group(0))
            return urllib.parse.urlunsplit(value._replace(netloc=value.netloc.rsplit('@', 1)[-1]))
        repositories[path] = re.sub(r'[a-zA-Z][a-zA-Z0-9+.-]*://[^\s<>"\x27]+', clean_url, content)
for path in sorted(evidence):
    if os.path.isfile(path):
        try:
            apt[path] = hashlib.sha256(open(path, 'rb').read()).hexdigest()
        except OSError:
            pass

unit = 'paddock@' + str(uid) + '.service'
files = {p: file(p) for p in paths}
# The backup an installation would write is named after the bytes it backs up; say whether one is already there.
for path in ['/etc/docker/daemon.json', '/etc/systemd/system/' + unit]:
    previous = files[path]
    if previous['kind'] == 'file':
        backup = path + '.paddock-' + previous['sha256']
        files[backup] = file(backup)

print(json.dumps(dict(
    os=os_release, system=platform.system(), arch=platform.machine(), libc=platform.libc_ver(),
    uid=uid, gid=os.getgid(), user=account.pw_name, home=account.pw_dir,
    machine=open('/etc/machine-id').read().strip(),
    boot=open('/proc/sys/kernel/random/boot_id').read().strip(),
    systemd=os.path.isdir('/run/systemd/system'),
    docker=info, containers=containers, packages=packages, downloads=downloads, apt=apt, repositories=repositories,
    files=files, ancestors=ancestors,
    unit=command(['systemctl', 'show', unit, '--property=LoadState,ActiveState,UnitFileState,User,Group,SupplementaryGroups,FragmentPath,ExecStart']),
    dockerGroup=command(['getent', 'group', 'docker']),
    lingering=command(['loginctl', 'show-user', str(uid), '--property=Linger']))))
`

// Runs the approved plan on the destination. The plan arrives on stdin, or in the private request file named by the
// first argument when a terminal is attached for sudo. Prints one JSON report; the journal records each step.
export const HOST_APPLY = String.raw`
import os, sys, json, subprocess, hashlib, urllib.request, shutil, base64, tarfile, io, tempfile

p = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else json.load(sys.stdin)
completed = []
started = None
stage = None

def report(value):
    print(('PADDOCK-RESULT ' if p.get('interactive') else '') + json.dumps(dict(value, stageDir=stage)), flush=True)

journal = p['stateDir'] + '/enrollment.json'

def save():
    if os.path.isdir(p['stateDir']):
        temp = journal + '.tmp'
        with open(temp, 'w') as f:
            os.chmod(temp, 0o600)
            json.dump(dict(hash=p['hash'], completed=completed, started=started, files=p['changes']), f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, journal)

def run(argv):
    r = subprocess.run(argv, capture_output=True, timeout=600)
    if r.returncode:
        raise RuntimeError(json.dumps(argv) + ': ' + r.stderr.decode(errors='replace')[-3000:] + r.stdout.decode(errors='replace')[-1000:])

try:
    os.umask(0o077)
    stage = tempfile.mkdtemp(prefix='paddock-enroll-')
    for item in p['uploads']:
        target = stage + '/' + item['name']
        if item['kind'] == 'artifact':
            # Binary bytes follow as base64 in this private SSH request, never in a plan or journal.
            data = base64.b64decode(p['artifactBytes'], validate=True)
        else:
            with urllib.request.urlopen(item['url'], timeout=120) as response:
                data = response.read(128 * 1024 * 1024)
        if hashlib.new(item['algorithm'], data).hexdigest() != item['checksum']:
            raise RuntimeError(item['name'] + ' checksum mismatch; nothing installed')
        if 'extract' not in item:
            with open(target, 'wb') as f:
                f.write(data)
            continue
        # An archive: exactly the files the plan names are taken from it, each checked, and nothing else may be in it.
        # Their paths come from the plan, never from the archive, so no member can be written outside staging.
        wanted = item['extract']['files']
        directories = {os.path.dirname(name) for name in wanted} - {''}
        taken = set()
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for member in archive.getmembers():
                if member.isdir() and member.name in directories:
                    continue
                if not member.isfile() or member.name not in wanted or member.name in taken:
                    raise RuntimeError(item['name'] + ' holds an unexpected entry ' + repr(member.name)[:200] + '; nothing installed')
                content = archive.extractfile(member).read()
                if hashlib.sha256(content).hexdigest() != wanted[member.name]:
                    raise RuntimeError(item['name'] + ' file ' + member.name + ' checksum mismatch; nothing installed')
                path = stage + '/' + item['extract']['directory'] + '/' + member.name
                os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
                with open(path, 'wb') as f:
                    f.write(content)
                taken.add(member.name)
        if taken != set(wanted):
            raise RuntimeError(item['name'] + ' lacks ' + ', '.join(sorted(set(wanted) - taken)) + '; nothing installed')
    for change in p['changes']:
        if change['after'] is not None:
            with open(stage + '/' + change['staged'], 'w') as f:
                f.write(change['after'])
    # Probe again, here and now: the steps below run only on the destination the plan was made for.
    check = subprocess.run(['python3', '-c', p['probeScript']], input=json.dumps(p['probeRequest']).encode(), capture_output=True, timeout=90)
    if check.returncode:
        raise RuntimeError('Final read-only probe failed: ' + check.stderr.decode())
    actual = json.loads(check.stdout)
    expected = dict(p['destination'])
    # Read by the primary's ssh, not by the probe.
    expected.pop('hostKey', None); expected.pop('hostPublicKey', None)
    if actual != expected:
        report(dict(ok=False, stale=True, completed=[], error='Inputs changed during artifact delivery; nothing installed'))
        sys.exit(0)

    # Staging was private. What root installs gets root's usual permissions, whatever umask sudo passes on.
    os.umask(0o022)
    for step in p['steps']:
        started = step['label']
        save()
        if p.get('interactive'):
            subprocess.run(['sudo', '-v'], check=True, timeout=120)
        run([arg.replace(p['stageDir'], stage) for arg in step['argv']])
        completed.append(step['label'])
        started = None
        save()
    report(dict(ok=True, completed=completed, journal=journal))
except Exception as e:
    try:
        if started or completed:
            save()
    except Exception:
        pass
    report(dict(ok=False, error=str(e), completed=completed, started=started, journal=journal))
    sys.exit(1)
finally:
    if stage:
        shutil.rmtree(stage)
    if len(sys.argv) > 1:
        os.unlink(sys.argv[1])
`

// Writes stdin to a new private file. It refuses a path that already exists or is a link.
export const HOST_REQUEST = String.raw`
import os, sys, shutil, tempfile

fd, path = tempfile.mkstemp(prefix='paddock-request-')
with os.fdopen(fd, 'wb') as f:
    shutil.copyfileobj(sys.stdin.buffer, f)
print(path, flush=True)
`
