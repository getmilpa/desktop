// Local incoming traffic does not restrict the backend's outgoing model connection.
// Apache-2.0 · (c) Rodrigo Vicente - TeamX Agency
const net = require('node:net')

function failure (code) { const error = new Error(code); error.code = code; return error }
function portNumber (port) {
  if (!/^[1-9][0-9]{0,4}$/.test(String(port)) || Number(port) > 65535) throw failure('backend.invalidPort')
  return String(port)
}
function launchNetwork (platform, port) {
  port = portNumber(port)
  // The non-root server must not acquire file capabilities that conceal its
  // socket descriptors from the same-UID observer in its private PID namespace.
  return platform === 'linux'
    ? { args: ['--network', 'host', '--security-opt', 'no-new-privileges=true', '-e', 'MILPA_HTTP_BIND_CONFIG=bind 127.0.0.1'], listen: `127.0.0.1:${port}` }
    : { args: ['-p', `127.0.0.1:${port}:${port}`, '-p', `[::1]:${port}:${port}`], listen: `0.0.0.0:${port}` }
}
function loopback (ip) {
  return (net.isIP(ip) === 4 && ip.startsWith('127.')) || ip === '::1'
}
// Test the adapter, not the presence of an environment variable the old image can ignore.
function requireLocalFrankenPHP (sh, image, port) {
  port = portNumber(port)
  try {
    const config = JSON.parse(sh('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'frankenphp',
      '-e', `PORT=${port}`, '-e', 'MILPA_HTTP_BIND_CONFIG=bind 127.0.0.1',
      '-e', 'MERCURE_PUBLISHER_JWT_KEY=desktop-bind-probe', '-e', 'MERCURE_SUBSCRIBER_JWT_KEY=desktop-bind-probe',
      image, 'adapt', '--config', '/etc/frankenphp/Caddyfile', '--adapter', 'caddyfile'], { timeout: 15000 }))
    const servers = Object.values(config.apps?.http?.servers || {})
    if (config.admin?.disabled !== true || servers.length !== 1 ||
        servers[0].automatic_https?.disable !== true ||
        JSON.stringify(servers[0].listen) !== JSON.stringify([`127.0.0.1:${port}`])) throw new Error('Unconfined server')
  } catch { throw failure('backend.imageBindUnsupported') }
}
// Both proc tables are required. A missing IPv6 table is unknown, never proof of no exposure.
const LISTENERS = String.raw`$owned=[]; foreach(glob('/proc/[0-9]*/fd/*') as $fd) {
  $link=@readlink($fd); if($link!==false && preg_match('/^socket:\[(\d+)\]$/',$link,$m)) $owned[$m[1]]=true;
}
$out=[]; foreach(['tcp','tcp6'] as $family) {
  $rows=@file('/proc/net/'.$family); if($rows===false) exit(2);
  foreach(array_slice($rows,1) as $row) { $f=preg_split('/\s+/',trim($row));
    if(count($f)<10) exit(3); if($f[3]!=='0A') continue;
    $local=explode(':',$f[1]); if(count($local)!==2) exit(4);
    $out[]=[$family,$local[0],hexdec($local[1]),isset($owned[$f[9]])];
  }
} echo json_encode($out,JSON_THROW_ON_ERROR);`
function localListeners (rows, port) {
  if (!Array.isArray(rows) || !rows.every(row => Array.isArray(row) && row.length === 4 && ['tcp', 'tcp6'].includes(row[0]) && typeof row[1] === 'string' && Number.isInteger(row[2]) && typeof row[3] === 'boolean')) return false
  const relevant = rows.filter(row => Array.isArray(row) && row.length === 4 && row[2] === Number(port))
  return relevant.some(row => row[3] === true) && relevant.every(([family, address]) =>
    (family === 'tcp' && /^[0-9A-F]{6}7F$/.test(address)) ||
    (family === 'tcp6' && address === '00000000000000000000000001000000'))
}
function requireLocalBackend (sh, container, name, port) {
  port = portNumber(port)
  try {
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Invalid container identity')
    const inspect = () => JSON.parse(sh('docker', ['inspect', '--format',
      '[{{json .Id}},{{json .Name}},{{json .State.Running}},{{json .HostConfig.NetworkMode}},{{json .NetworkSettings.Ports}},{{json .State.Pid}},{{json .State.StartedAt}},{{json .HostConfig.PidMode}}]', container], { timeout: 5000 }))
    const data = inspect()
    if (!Array.isArray(data) || data.length !== 8 || data[0] !== container || data[1] !== '/' + name || data[2] !== true || !Number.isSafeInteger(data[5]) || data[5] <= 0 || typeof data[6] !== 'string' || !data[6]) throw new Error('Unknown backend')
    if (data[3] === 'host') {
      if (data[7] !== '' && data[7] !== 'private') throw new Error('Shared process namespace')
      if (!localListeners(JSON.parse(sh('docker', ['exec', container, 'php', '-r', LISTENERS], { timeout: 5000 })), port)) throw new Error('Unconfined listener')
    } else if (data[3] === 'default' || data[3] === 'bridge') {
      const bindings = data[4]?.[`${port}/tcp`]
      if (!Array.isArray(bindings) || bindings.length === 0 || !bindings.every(b => loopback(b.HostIp) && b.HostPort === port)) throw new Error('Unconfined mapping')
      // Another published service on the backend must not silently remain public either.
      if (!Object.values(data[4]).every(list => list === null || (Array.isArray(list) && list.every(b => loopback(b.HostIp))))) throw new Error('Other public mapping')
    } else { throw new Error('Unknown network mode') }
    if (JSON.stringify(inspect()) !== JSON.stringify(data)) throw new Error('Backend changed during observation')
  } catch { throw failure('backend.bindUnverified') }
}
module.exports = { launchNetwork, requireLocalFrankenPHP, requireLocalBackend, localListeners, LISTENERS }
