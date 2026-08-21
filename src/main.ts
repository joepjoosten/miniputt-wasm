import "./style.css"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

type WasmGame = {
  reset(hole: number): void
  place(x: number, y: number): number
  shoot(pullX: number, pullY: number): number
  step(deltaSeconds: number): void
  getBallX(): number
  getBallY(): number
  getVelocityX(): number
  getVelocityY(): number
  getStrokes(): number
  isPlaced(): number
  isMoving(): number
  isSunk(): number
  getCurrentHole(): number
  getTeeLeft(): number
  getTeeTop(): number
  getTeeRight(): number
  getTeeBottom(): number
  getHoleX(): number
  getHoleY(): number
}

type Phase = "placing" | "ready" | "aiming" | "rolling" | "sunk" | "finished"
type UiState = Readonly<{
  hole: number
  strokes: number
  totalStrokes: number
  phase: Phase
  message: string
}>

type Point = { x: number; y: number }
type Course = {
  par: number
  label: string
  fairways: ReadonlyArray<readonly [number, number, number, number]>
  bumpers: ReadonlyArray<readonly [number, number, number]>
}

const WIDTH = 930
const HEIGHT = 650
const BALL_RADIUS = 11
const MAX_PULL = 155

const courses: ReadonlyArray<Course> = [
  { par: 3, label: "The Keyhole", fairways: [[205,55,610,205],[335,235,135,255],[205,465,470,155]], bumpers: [[540,151,28],[630,151,28]] },
  { par: 4, label: "Roundabout", fairways: [[110,80,240,495],[325,80,500,165],[595,220,230,355]], bumpers: [[230,300,31],[710,330,38]] },
  { par: 4, label: "Back Nine Bend", fairways: [[110,390,730,205],[110,80,195,335],[280,80,560,170]], bumpers: [[405,488,35],[565,488,35],[690,165,32]] }
]

const initialState: UiState = { hole: 0, strokes: 0, totalStrokes: 0, phase: "placing", message: "Tap inside the striped tee area to place your ball." }
const gameState = Atom.make<UiState>(initialState)
const registry = AtomRegistry.make()

const canvas = document.querySelector<HTMLCanvasElement>("#course")!
const context = canvas.getContext("2d", { alpha: false })!
const loading = document.querySelector<HTMLDivElement>("#loading")!
const toast = document.querySelector<HTMLDivElement>("#toast")!
const tutorial = document.querySelector<HTMLDivElement>("#tutorial")!
const instruction = document.querySelector<HTMLParagraphElement>("#instruction")!
const stepNumber = document.querySelector<HTMLSpanElement>(".step-number")!
const holeValue = document.querySelector<HTMLElement>("#hole-value")!
const parValue = document.querySelector<HTMLElement>("#par-value")!
const strokeValue = document.querySelector<HTMLElement>("#stroke-value")!
const resetButton = document.querySelector<HTMLButtonElement>("#reset-button")!
const soundButton = document.querySelector<HTMLButtonElement>("#sound-button")!

let wasm: WasmGame
let aimPoint: Point | null = null
let activePointer: number | null = null
let lastFrame = performance.now()
let lastUiStroke = -1
let holeAdvanceTimer: number | undefined
let soundEnabled = true
let audioContext: AudioContext | undefined

const updateState = (patch: Partial<UiState>) => registry.update(gameState, current => ({ ...current, ...patch }))

registry.subscribe(gameState, state => {
  const course = courses[state.hole] ?? courses[0]!
  holeValue.textContent = `${state.hole + 1} / ${courses.length}`
  parValue.textContent = String(course.par)
  strokeValue.textContent = String(state.strokes)
  instruction.textContent = state.message
  stepNumber.textContent = state.phase === "placing" ? "1" : state.phase === "finished" ? "✓" : "2"
  tutorial.classList.toggle("done", state.phase === "rolling" || state.phase === "sunk")
  if (state.phase === "sunk" || state.phase === "finished") {
    toast.textContent = state.phase === "finished" ? `Round complete · ${state.totalStrokes} strokes` : state.strokes <= course.par ? "Nice putt!" : "In the cup!"
    toast.classList.add("visible")
  } else {
    toast.classList.remove("visible")
  }
}, { immediate: true })

function canvasPoint(event: PointerEvent): Point {
  const bounds = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - bounds.left) / bounds.width * WIDTH,
    y: (event.clientY - bounds.top) / bounds.height * HEIGHT
  }
}

function resizeCanvas(): void {
  const bounds = canvas.getBoundingClientRect()
  const density = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, Math.round(bounds.width * density))
  const height = Math.max(1, Math.round(bounds.height * density))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, radius)
}

function drawCourse(): void {
  resizeCanvas()
  const scaleX = canvas.width / WIDTH
  const scaleY = canvas.height / HEIGHT
  const state = registry.get(gameState)
  const course = courses[state.hole] ?? courses[0]!

  context.setTransform(scaleX, 0, 0, scaleY, 0, 0)
  context.fillStyle = "#344139"
  context.fillRect(0, 0, WIDTH, HEIGHT)

  const groundGradient = context.createRadialGradient(WIDTH * .45, HEIGHT * .5, 20, WIDTH * .45, HEIGHT * .5, 630)
  groundGradient.addColorStop(0, "#4b5947")
  groundGradient.addColorStop(1, "#303a34")
  context.fillStyle = groundGradient
  context.fillRect(0, 0, WIDTH, HEIGHT)

  context.save()
  context.shadowColor = "rgba(0,0,0,.36)"
  context.shadowBlur = 22
  context.shadowOffsetY = 10
  context.fillStyle = "#b97b3e"
  context.strokeStyle = "#dda45c"
  context.lineWidth = 18
  for (const [x,y,w,h] of course.fairways) {
    drawRoundedRect(context, x, y, w, h, 9)
    context.fill()
    context.stroke()
  }
  context.restore()

  context.fillStyle = "#2eab65"
  context.strokeStyle = "#5ac87e"
  context.lineWidth = 2
  for (const [x,y,w,h] of course.fairways) {
    drawRoundedRect(context, x + 9, y + 9, w - 18, h - 18, 4)
    context.fill()
    context.stroke()
  }

  context.save()
  context.globalAlpha = .12
  context.strokeStyle = "#f0ffe6"
  context.lineWidth = 1
  for (let x = -HEIGHT; x < WIDTH + HEIGHT; x += 18) {
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x + HEIGHT, HEIGHT); context.stroke()
  }
  context.restore()

  const teeLeft = wasm.getTeeLeft()
  const teeTop = wasm.getTeeTop()
  const teeWidth = wasm.getTeeRight() - teeLeft
  const teeHeight = wasm.getTeeBottom() - teeTop
  const teePattern = context.createLinearGradient(teeLeft, teeTop, teeLeft + teeWidth, teeTop)
  teePattern.addColorStop(0, "rgba(12,92,55,.60)")
  teePattern.addColorStop(.5, "rgba(19,114,67,.35)")
  teePattern.addColorStop(1, "rgba(12,92,55,.60)")
  context.fillStyle = teePattern
  drawRoundedRect(context, teeLeft, teeTop, teeWidth, teeHeight, 8)
  context.fill()
  context.strokeStyle = "rgba(226,255,199,.58)"
  context.lineWidth = 1.5
  context.setLineDash([7, 7])
  context.stroke()
  context.setLineDash([])

  for (const [x,y,radius] of course.bumpers) drawBumper(x,y,radius)
  drawHole(wasm.getHoleX(), wasm.getHoleY())

  if (wasm.isPlaced()) drawBall(wasm.getBallX(), wasm.getBallY(), wasm.isSunk() === 1)
  if (aimPoint && state.phase === "aiming") drawAim(aimPoint)

  context.fillStyle = "rgba(244,240,220,.86)"
  context.font = "700 12px 'DM Sans', sans-serif"
  context.letterSpacing = "1px"
  context.fillText(course.label.toUpperCase(), 25, 34)
}

function drawBumper(x: number, y: number, radius: number): void {
  context.save()
  context.shadowColor = "rgba(0,0,0,.34)"
  context.shadowBlur = 8
  context.shadowOffsetY = 5
  const gradient = context.createRadialGradient(x - radius * .35, y - radius * .42, 2, x, y, radius)
  gradient.addColorStop(0, "#f1eee5")
  gradient.addColorStop(.65, "#bbbcb8")
  gradient.addColorStop(1, "#767d78")
  context.fillStyle = gradient
  context.beginPath()
  context.arc(x, y, radius, 0, Math.PI * 2)
  context.fill()
  context.restore()
}

function drawHole(x: number, y: number): void {
  const gradient = context.createRadialGradient(x - 3, y - 3, 1, x, y, 16)
  gradient.addColorStop(0, "#050807")
  gradient.addColorStop(.72, "#0c1410")
  gradient.addColorStop(1, "rgba(0,0,0,.3)")
  context.fillStyle = gradient
  context.beginPath(); context.ellipse(x, y, 15, 11, 0, 0, Math.PI * 2); context.fill()
  context.strokeStyle = "rgba(255,255,255,.28)"; context.lineWidth = 1; context.stroke()
  context.strokeStyle = "#f7f3df"; context.lineWidth = 2
  context.beginPath(); context.moveTo(x, y - 5); context.lineTo(x, y - 59); context.stroke()
  context.fillStyle = "#ef7f49"
  context.beginPath(); context.moveTo(x + 1, y - 58); context.lineTo(x + 38, y - 46); context.lineTo(x + 1, y - 35); context.closePath(); context.fill()
}

function drawBall(x: number, y: number, sunk: boolean): void {
  context.save()
  context.globalAlpha = sunk ? .25 : 1
  context.shadowColor = "rgba(0,0,0,.45)"; context.shadowBlur = 7; context.shadowOffsetY = 5
  const gradient = context.createRadialGradient(x - 4, y - 5, 1, x, y, BALL_RADIUS)
  gradient.addColorStop(0, "#fffef9"); gradient.addColorStop(.6, "#e9e7de"); gradient.addColorStop(1, "#9fa39e")
  context.fillStyle = gradient
  context.beginPath(); context.arc(x, y, BALL_RADIUS, 0, Math.PI * 2); context.fill()
  context.restore()
}

function drawAim(pointer: Point): void {
  const ball = { x: wasm.getBallX(), y: wasm.getBallY() }
  const dx = ball.x - pointer.x
  const dy = ball.y - pointer.y
  const distance = Math.hypot(dx, dy)
  if (distance < 1) return
  const pull = Math.min(distance, MAX_PULL)
  const ux = dx / distance
  const uy = dy / distance
  const targetX = ball.x + ux * pull * 1.25
  const targetY = ball.y + uy * pull * 1.25

  context.save()
  context.strokeStyle = "rgba(244,240,220,.88)"
  context.lineWidth = 3
  context.setLineDash([7, 8])
  context.beginPath(); context.moveTo(ball.x + ux * 18, ball.y + uy * 18); context.lineTo(targetX, targetY); context.stroke()
  context.setLineDash([])
  context.fillStyle = pull > 112 ? "#ef7f49" : "#c9f65c"
  context.beginPath(); context.arc(pointer.x, pointer.y, 9 + pull / 35, 0, Math.PI * 2); context.fill()
  context.strokeStyle = "rgba(255,255,255,.7)"; context.lineWidth = 2; context.stroke()
  context.restore()
}

function playTone(frequency: number, duration = .08): void {
  if (!soundEnabled) return
  audioContext ??= new AudioContext()
  const oscillator = audioContext.createOscillator()
  const gain = audioContext.createGain()
  oscillator.type = "sine"
  oscillator.frequency.value = frequency
  gain.gain.setValueAtTime(.07, audioContext.currentTime)
  gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration)
  oscillator.connect(gain).connect(audioContext.destination)
  oscillator.start()
  oscillator.stop(audioContext.currentTime + duration)
}

function startHole(hole: number, totalStrokes: number): void {
  window.clearTimeout(holeAdvanceTimer)
  wasm.reset(hole)
  aimPoint = null
  lastUiStroke = -1
  updateState({ hole, strokes: 0, totalStrokes, phase: "placing", message: "Tap inside the striped tee area to place your ball." })
}

canvas.addEventListener("pointerdown", event => {
  if (activePointer !== null) return
  const state = registry.get(gameState)
  const point = canvasPoint(event)
  if (state.phase === "placing") {
    if (wasm.place(point.x, point.y)) {
      playTone(520, .06)
      updateState({ phase: "ready", message: "Press the ball, drag back, then release to putt." })
    }
    return
  }

  if (state.phase !== "ready" || wasm.isMoving()) return
  const distance = Math.hypot(point.x - wasm.getBallX(), point.y - wasm.getBallY())
  if (distance > 34) return
  event.preventDefault()
  activePointer = event.pointerId
  canvas.setPointerCapture(event.pointerId)
  aimPoint = point
  updateState({ phase: "aiming", message: "Release when the power and direction feel right." })
})

canvas.addEventListener("pointermove", event => {
  if (event.pointerId !== activePointer) return
  event.preventDefault()
  aimPoint = canvasPoint(event)
})

function finishAim(event: PointerEvent): void {
  if (event.pointerId !== activePointer) return
  const point = canvasPoint(event)
  const pullX = wasm.getBallX() - point.x
  const pullY = wasm.getBallY() - point.y
  activePointer = null
  aimPoint = null
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  if (wasm.shoot(pullX, pullY)) {
    playTone(190, .1)
    updateState({ strokes: wasm.getStrokes(), phase: "rolling", message: "Let it roll…" })
  } else {
    updateState({ phase: "ready", message: "Press the ball and pull back a little farther." })
  }
}

canvas.addEventListener("pointerup", finishAim)
canvas.addEventListener("pointercancel", finishAim)

resetButton.addEventListener("click", () => {
  const state = registry.get(gameState)
  startHole(state.hole, state.totalStrokes)
})

soundButton.addEventListener("click", () => {
  soundEnabled = !soundEnabled
  soundButton.textContent = soundEnabled ? "Sound on" : "Sound off"
  soundButton.setAttribute("aria-pressed", String(soundEnabled))
  if (soundEnabled) playTone(440, .05)
})

window.addEventListener("resize", resizeCanvas)

function frame(now: number): void {
  wasm.step((now - lastFrame) / 1000)
  lastFrame = now

  const strokes = wasm.getStrokes()
  if (strokes !== lastUiStroke) {
    lastUiStroke = strokes
    updateState({ strokes })
  }

  const state = registry.get(gameState)
  if (state.phase === "rolling" && !wasm.isMoving() && !wasm.isSunk()) {
    updateState({ phase: "ready", message: "Press the ball, drag back, then release for your next putt." })
  }

  if (wasm.isSunk() && state.phase !== "sunk" && state.phase !== "finished") {
    const totalStrokes = state.totalStrokes + strokes
    playTone(660, .1)
    window.setTimeout(() => playTone(880, .15), 90)
    if (state.hole === courses.length - 1) {
      updateState({ phase: "finished", totalStrokes, message: `Round complete in ${totalStrokes} strokes.` })
    } else {
      updateState({ phase: "sunk", totalStrokes, message: "Great finish. Next hole coming up…" })
      holeAdvanceTimer = window.setTimeout(() => startHole(state.hole + 1, totalStrokes), 1350)
    }
  }

  drawCourse()
  requestAnimationFrame(frame)
}

async function boot(): Promise<void> {
  const response = await fetch(`${import.meta.env.BASE_URL}miniputt.wasm`)
  const module = await WebAssembly.instantiateStreaming(response)
  wasm = module.instance.exports as unknown as WasmGame
  wasm.reset(0)
  loading.classList.add("hidden")
  resizeCanvas()
  requestAnimationFrame(frame)
}

boot().catch(error => {
  console.error(error)
  loading.textContent = "The course could not be loaded. Please refresh and try again."
})

