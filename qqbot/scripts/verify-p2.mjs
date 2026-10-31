/**
 * Standalone check for P2: bubble splitting, mood decay, follow-ups and
 * proactive trigger selection.
 *
 *   npm run build:standalone && node scripts/verify-p2.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitBubbles, Humanizer } from '../dist/standalone/delivery/humanize.js'
import { MemoryDb } from '../dist/standalone/memory/db.js'
import { FollowUpStore } from '../dist/standalone/memory/followups.js'
import { MoodStore } from '../dist/standalone/memory/state.js'
import { isQuietAt, pickTrigger } from '../dist/standalone/proactive/triggers.js'

const root = mkdtempSync(join(tmpdir(), 'p2-'))
const log = () => {}
let failures = 0

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

const config = {
  enabled: true,
  minIntervalMinutes: 90,
  maxIntervalMinutes: 240,
  quietStart: '23:30',
  quietEnd: '08:30',
  idleMinutes: 45,
  probability: 0.6,
  tickMinutes: 2,
  maxPerDay: 6,
  morningStart: '08:30',
  morningEnd: '10:30',
  eveningStart: '20:30',
  eveningEnd: '23:00',
}

function at(hour, minute = 0) {
  const date = new Date(2026, 9, 31, hour, minute, 0, 0)
  return date.getTime()
}

try {
  console.log('\n[bubbles]')
  check('short reply stays one bubble', splitBubbles('嗯嗯', 3).length === 1)
  const three = splitBubbles('我今天加班了。好累啊。想早点睡。', 3)
  check('three sentences -> three bubbles', three.length === 3, JSON.stringify(three))
  check('order preserved', three[0].startsWith('我今天') && three[2].includes('早点睡'), JSON.stringify(three))
  const capped = splitBubbles('第一句。第二句。第三句。第四句。第五句。', 2)
  check('bubble cap respected', capped.length === 2, JSON.stringify(capped))
  check('cap keeps all text', ['第一句', '第二句', '第三句', '第四句', '第五句'].every(part => capped.join('').includes(part)), JSON.stringify(capped))
  const structured = splitBubbles('1. 第一项\n2. 第二项\n3. 第三项', 3)
  check('structured text not split mid-list', structured.length === 1 && structured[0].includes('第二项'), JSON.stringify(structured))
  const long = splitBubbles('第一段。'.repeat(300) + '\n\n' + '第二段。'.repeat(300), 3)
  check('long text bounded by cap', long.length <= 3, JSON.stringify(long.map(part => part.length)))

  console.log('\n[humanizer]')
  const sent = []
  const typing = []
  const sleeps = []
  const humanizer = new Humanizer(
    { enabled: true, maxBubbles: 3, minDelayMs: 10, maxDelayMs: 50, delayPerCharMs: 1, extraDelayMinMs: 500, extraDelayMaxMs: 850 },
    {
      send: async (_chatId, text) => { sent.push(text) },
      typing: (_chatId, on) => { typing.push(on) },
      sleep: async ms => { sleeps.push(ms) },
    },
    log,
  )
  const count = await humanizer.send('c', '第一句。第二句。第三句。')
  check('humanizer sends every bubble', count === 3 && sent.length === 3, JSON.stringify(sent))
  check('typing toggles around each bubble', typing.join(',') === 'true,false,true,false,true,false', JSON.stringify(typing))
  const typingDelays = sleeps.filter((_, index) => index % 2 === 0)
  check('first bubble gets the extra 0.5-0.85s', typingDelays[0] >= 510 && typingDelays[0] <= 900, JSON.stringify(typingDelays))
  check('later bubbles keep the base delay', typingDelays.slice(1).every(ms => ms >= 10 && ms <= 50), JSON.stringify(typingDelays))
  const flatSent = []
  const flat = new Humanizer(
    { enabled: false, maxBubbles: 3, minDelayMs: 10, maxDelayMs: 50, delayPerCharMs: 1 },
    { send: async (_chatId, text) => { flatSent.push(text) }, typing: () => {} },
    log,
  )
  await flat.send('c', '第一句。第二句。')
  check('disabled humanizer still splits without typing', flatSent.length === 2)

  console.log('\n[mood]')
  const db = new MemoryDb(join(root, 'chat.db'), log)
  const now = Date.now()
  const moods = new MoodStore(db, true, () => now)
  const initial = moods.get()
  check('defaults', initial.mood === 55 && initial.energy === 70 && initial.affection === 50, JSON.stringify(initial))
  const raised = moods.apply({ mood: 15, energy: -10, affection: 5 })
  check('delta applied', raised.mood === 70 && raised.energy === 60 && raised.affection === 55, JSON.stringify(raised))
  check('prompt description', moods.describe().includes('心情 70/100') && moods.describe().includes('亲密度'), moods.describe())
  check('sociable multiplier', moods.proactiveMultiplier() === 1.25, String(moods.proactiveMultiplier()))

  db.setState('mood', '90')
  db.setState('energy', '90')
  db.setState('mood_updated_at', String(now - 48 * 3_600_000))
  const decayed = new MoodStore(db, true, () => now).get()
  check('mood halves toward baseline in 48h', decayed.mood >= 72 && decayed.mood <= 73, JSON.stringify(decayed))
  check('energy decays faster', decayed.energy <= 66, JSON.stringify(decayed))

  console.log('\n[follow-ups]')
  const followUps = new FollowUpStore(db)
  const first = followUps.schedule('周三的面试', now + 60_000, now)
  check('scheduled', Number.isFinite(first.id) && !first.duplicate, JSON.stringify(first))
  const again = followUps.schedule('周三的面试', now + 120_000, now)
  check('duplicate topic not inserted', again.duplicate && again.id === first.id, JSON.stringify(again))
  check('due after time passes', followUps.due(now + 61_000).some(item => item.id === first.id))
  followUps.complete(first.id)
  check('completed disappears from due list', followUps.due(now + 61_000).every(item => item.id !== first.id))

  console.log('\n[triggers]')
  const base = {
    config,
    idleMs: 20 * 60_000,
    nextRandomAt: at(12, 0),
    dailyCount: 0,
    firedMorning: false,
    firedEvening: false,
    moodMultiplier: 1,
    dueFollowUps: [],
    random: () => 0.1,
  }
  check('quiet hours block everything', pickTrigger({ ...base, now: at(23, 45) }) === undefined)
  const morning = pickTrigger({ ...base, now: at(9, 0) })
  check('morning window', morning?.kind === 'morning', JSON.stringify(morning))
  check('morning needs idle time', pickTrigger({ ...base, now: at(9, 0), idleMs: 2 * 60_000 }) === undefined)
  check('morning fires once', pickTrigger({ ...base, now: at(9, 30), firedMorning: true }) === undefined)
  check('evening window', pickTrigger({ ...base, now: at(21, 0) })?.kind === 'evening')

  const due = [{ id: 7, topic: '电影', due_at: at(13, 0) }]
  const followUp = pickTrigger({ ...base, now: at(14, 0), dailyCount: 99, dueFollowUps: due })
  check('follow-up beats the daily cap', followUp?.kind === 'followup' && followUp.followUpId === 7, JSON.stringify(followUp))

  check('daily cap blocks idle chat', pickTrigger({ ...base, now: at(15, 0), nextRandomAt: at(14, 0), dailyCount: 6 }) === undefined)
  check('idle probability miss', pickTrigger({ ...base, now: at(15, 0), nextRandomAt: at(14, 0), random: () => 0.9 }) === undefined)
  const idle = pickTrigger({ ...base, now: at(15, 0), nextRandomAt: at(14, 0), idleMs: 46 * 60_000 })
  check('idle fires with mood-scaled probability', idle?.kind === 'idle', JSON.stringify(idle))
  check('idle needs quiet chat', pickTrigger({ ...base, now: at(15, 0), nextRandomAt: at(14, 0), idleMs: 10 * 60_000 }) === undefined)
  check('quiet helper crosses midnight', isQuietAt(at(0, 30), config))
  check('quiet helper daytime false', !isQuietAt(at(12, 0), config))

  console.log('\n[tools through MemoryService]')
  const { MemoryService } = await import('../dist/standalone/memory/index.js')
  const { executeTool } = await import('../dist/standalone/agent/tools.js')
  const service = new MemoryService({
    enabled: true,
    dbPath: join(root, 'service.db'),
    extractEveryTurns: 10,
    idleExtractMinutes: 10,
    maxRecallFacts: 8,
    maxRecallChars: 500,
    maxRecallSnippets: 2,
    maxSnippetChars: 120,
    extractMaxChars: 16_000,
    minConfidence: 0.6,
    summaryHour: 3,
    moodEnabled: true,
  }, {}, log)
  await service.start()
  const toolCtx = {
    chatId: 'c',
    sendText: async () => {},
    sendImage: async () => {},
    markSent: () => {},
    memes: {},
    persona: {},
    memory: service,
    lastImages: [],
    log,
  }
  const moodTool = await executeTool('update_mood', { mood: 10, energy: -5 }, toolCtx)
  check('update_mood tool responds', moodTool.includes('状态已更新') && moodTool.includes('精力'), moodTool)
  check('mood store changed', service.mood().mood === 65, JSON.stringify(service.mood()))
  const followTool = await executeTool('schedule_follow_up', { topic: '周三的面试', delay_minutes: 30 }, toolCtx)
  check('schedule_follow_up tool responds', followTool.includes('已记下'), followTool)
  check('follow-up visible to service', service.dueFollowUps(Date.now() + 31 * 60_000).length === 1)
  const duplicateTool = await executeTool('schedule_follow_up', { topic: '周三的面试', delay_minutes: 30 }, toolCtx)
  check('duplicate reported by tool', duplicateTool.includes('已经有这条跟进'), duplicateTool)
  service.close()

  db.close()
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
