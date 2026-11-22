// Apache-2.0 · (c) Rodrigo Vicente - TeamX Agency
// Detached groups belong to this invocation, including when an outer CI timeout interrupts it.
import fs from 'node:fs'
import { spawn } from 'node:child_process'
const owned = new Set()
let stopping = false
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export function liveGroup (pid) {
  return fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).filter(name => {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return Number(fields[2]) === pid && fields[0] !== 'Z'
    } catch { return false }
  })
}
export function spawnOwned (command, args, options) {
  if (stopping) throw new Error('Cannot launch after cleanup has started')
  const child = spawn(command, args, { ...options, detached: true })
  if (child.pid) owned.add(child.pid)
  return child
}
export async function stopOwned (pid) {
  if (!owned.has(pid)) return
  try { process.kill(-pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await delay(250)
  try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await delay(100)
  if (liveGroup(pid).length) throw new Error('Launched process group did not terminate')
  owned.delete(pid)
}
export function installSignalCleanup () {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    process.on(signal, async () => {
      if (stopping) return
      stopping = true
      const results = await Promise.allSettled([...owned].map(stopOwned))
      for (const result of results) if (result.status === 'rejected') console.error(result.reason)
      process.exit(results.some(result => result.status === 'rejected') ? 1 : code)
    })
  }
}
