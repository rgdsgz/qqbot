#!/usr/bin/env node
/**
 * Standalone entry point: no DSH, no Cordis, no profile.
 *
 *   node lib/standalone/main.js --config ./config.json
 *
 * Wires OneBot/NapCat transport + outbound pipeline (reused from the plugin)
 * to the standalone agent (LLM + sessions + tools + proactive).
 * @module dsh-onebot/standalone/main
 */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { OneBotConnection } from '../connection.js'
import { MediaStore } from '../media.js'
import { OutboundPipeline, type OutboundContext } from '../outbound.js'
import { ChatAgent } from './agent/index.js'
import { Humanizer } from './delivery/humanize.js'
import { StandaloneBridge } from './transport/bridge.js'
import { loadConfig, type LogLevel, type StandaloneConfig } from './config.js'
import { LlmClient } from './agent/llm.js'
import { MemeLibrary } from './meme/library.js'
import { describeMeme } from './meme/tag.js'
import { MemoryService } from './memory/index.js'
import { OwnerStore } from './owner/store.js'
import { PersonaStore } from './persona/index.js'
import { ProactiveScheduler } from './proactive/scheduler.js'
import { SessionStore } from './session/store.js'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

interface Options {
  configPath: string
  echo: boolean
}

function parseArgs(argv: string[]): Options {
  let configPath = process.env.QQBOT_CONFIG ?? './config.json'
  let echo = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config' || arg === '-c') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--config 需要跟一个路径')
      configPath = value
      index += 1
    } else if (arg === '--echo') {
      echo = true
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        '用法: node lib/standalone/main.js [--config config.json] [--echo]',
        '',
        '  --config, -c  配置文件路径，默认 ./config.json（或环境变量 QQBOT_CONFIG）',
        '  --echo        不调用模型，原样回显，用来测试 NapCat 链路',
      ].join('\n'))
      process.exit(0)
    }
  }
  return { configPath, echo }
}

function makeLogger(level: LogLevel): (level: LogLevel, message: string) => void {
  const threshold = LEVELS[level]
  return (messageLevel, message) => {
    if (LEVELS[messageLevel] < threshold) return
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const line = `[qqbot ${time} ${messageLevel}] ${message}`
    if (messageLevel === 'error') console.error(line)
    else console.log(line)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const config = await loadConfig(resolve(options.configPath), options.echo)
  const log = makeLogger(config.logLevel)

  log('info', '启动独立 QQ 机器人（不依赖 DSH）')
  log('info', `主人 QQ: ${config.owner.qq || '未绑定（首条私聊自动绑定）'}；NapCat: ${config.napcat.mode} ${config.napcat.mode === 'reverse' ? `${config.napcat.host}:${config.napcat.port}` : config.napcat.url}`)
  if (config.echo) log('warn', 'Echo 模式：不会调用模型')

  await prepareDirs(config)

  const media = new MediaStore(
    resolve(config.dataDir, 'media'),
    config.media.ttlHours,
    config.media.imageMaxSize,
    { maxBytes: config.media.maxImageBytes, allowPrivateHosts: false },
  )
  const sessions = new SessionStore(resolve(config.dataDir, 'sessions'), log)
  await sessions.ensure()
  const owner = new OwnerStore(config.dataDir, config.owner.qq, log)
  await owner.load()
  const memes = new MemeLibrary(config.memes.dirs, log, {
    indexFile: resolve(config.memes.dirs[0] ?? resolve(config.dataDir, 'memes'), 'index.json'),
    tags: config.memes.tags,
    autoTag: config.memes.autoTag,
    avoidRepeatHours: config.memes.avoidRepeatHours,
  })
  await memes.scan()
  const persona = new PersonaStore(config.persona, log)
  await persona.ensure()
  const llm = new LlmClient(config.llm, log)
  // Vision auto-tagging is attached after the client exists; learn_meme uses it.
  memes.setTagger(path => describeMeme(llm, path, log))
  const memory = new MemoryService(config.memory, llm, log, config.embedding)
  await memory.start()
  const personaStatus = await persona.status()
  log('info', `人设: SOUL ${personaStatus.soul.chars}/${personaStatus.soul.limit}，USER ${personaStatus.user.chars}/${personaStatus.user.limit}，MEMORY ${personaStatus.memory.chars}/${personaStatus.memory.limit}`)
  let bridge: StandaloneBridge
  const humanizer = new Humanizer(config.humanize, {
    send: (chatId: string, text: string): Promise<void> => bridge.sendText(chatId, text),
    typing: (chatId: string, on: boolean): void => bridge.typing(chatId, on),
  }, log)
  const agent: ChatAgent = new ChatAgent({
    config,
    llm,
    sessions,
    memes,
    persona,
    memory,
    humanize: humanizer,
    sendText: (chatId: string, text: string): Promise<void> => bridge.sendText(chatId, text),
    sendImage: (chatId: string, path: string, caption?: string, url?: string): Promise<void> => bridge.sendImage(chatId, path, caption, url),
    typing: (chatId: string, on: boolean): void => bridge.typing(chatId, on),
    log,
  })

  const connection = new OneBotConnection({
    mode: config.napcat.mode,
    host: config.napcat.host,
    port: config.napcat.port,
    url: config.napcat.url,
    accessToken: config.napcat.accessToken,
    callTimeoutMs: config.napcat.callTimeoutMs,
    log,
  })

  let stopping = false
  const chatSinks = new Map<string, { lastNickname: string }>()
  const outboundConfig = {
    botQQ: config.bot.qq,
    sensitivePatterns: [] as readonly string[],
    textImageThreshold: 0,
    maxImageBytes: config.media.maxImageBytes,
    cardFooter: '',
    fontFiles: [] as readonly string[],
    fontFamilies: [] as readonly string[],
    mediaDir: resolve(config.dataDir, 'media'),
    actionRatePerMinute: 30,
    actionRatePerDay: 1000,
    actionAuditEnabled: false,
  }
  const outboundContext: OutboundContext = {
    getChat: chatId => chatSinks.get(chatId),
    connected: () => connection.connected,
    selfId: () => connection.selfId || config.bot.qq,
    call: (action, params) => connection.call(action, params),
    isStopping: () => stopping,
    log,
    config: outboundConfig,
  }
  const outbound = new OutboundPipeline(outboundContext)

  let scheduler: ProactiveScheduler | undefined
  const startProactive = (): void => {
    const qq = owner.current()
    if (qq === '' || scheduler !== undefined) return
    const chatId = 'private:' + qq
    chatSinks.set(chatId, { lastNickname: config.owner.name })
    scheduler = new ProactiveScheduler({ config, chatId, agent, sessions, memory, connection, log })
    scheduler.start()
  }

  bridge = new StandaloneBridge({
    config,
    connection,
    outbound,
    media,
    memes,
    agent,
    owner,
    log,
    onActivity: () => scheduler?.noteActivity(),
    onOwnerBound: () => startProactive(),
  })

  connection.onMessage = event => {
    void bridge.handleEvent(event).catch(error => log('error', `入站处理失败: ${describe(error)}`))
  }
  connection.onMeta = event => {
    if (event.self_id !== undefined) log('info', `机器人 QQ: ${event.self_id}`)
  }
  connection.onStatus = connected => {
    log(connected ? 'info' : 'warn', connected ? 'NapCat 已连接' : 'NapCat 断开')
  }

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    log('info', `收到 ${signal}，正在退出...`)
    scheduler?.stop()
    await bridge.stop()
    await sessions.flushAll()
    await memes.close()
    memory.close()
    await connection.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', reason => log('error', '未处理的 Promise 拒绝: ' + describe(reason)))

  bridge.start()
  connection.start()
  startProactive()
  if (owner.current() === '') {
    log('info', '就绪。现在用你的大号（或任意号）私聊小号，第一条私聊会绑定为主人。')
  } else {
    log('info', `就绪。主人 QQ: ${owner.current()}，用这个号私聊机器人即可。`)
  }
}

async function prepareDirs(config: StandaloneConfig): Promise<void> {
  for (const dir of [
    config.dataDir,
    resolve(config.dataDir, 'media'),
    resolve(config.dataDir, 'sessions'),
    resolve(config.dataDir, 'outbox'),
    resolve(config.dataDir, 'persona'),
    resolve(config.dataDir, 'memory'),
    resolve(config.dataDir, 'logs'),
    ...config.memes.dirs,
    resolve(config.memes.dirs[0] ?? resolve(config.dataDir, 'memes'), 'inbox'),
  ]) {
    await mkdir(dir, { recursive: true })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

void main().catch(error => {
  console.error('[qqbot] 启动失败: ' + describe(error))
  process.exit(1)
})
