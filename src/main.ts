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
  instructionsVisible: boolean
}>

type Point = { x: number; y: number }
type Viewport = { x: number; y: number; zoom: number }
type PinchGesture = {
  startDistance: number
  startZoom: number
  anchorWorld: Point
}
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
const COURSE_CACHE_SCALE = 2
const INACTIVITY_HELP_DELAY = 60_000
const DEFAULT_SOUND_ENABLED = true

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const courses: ReadonlyArray<Course> = [
  { par: 3, label: "The Keyhole", fairways: [[205,55,610,205],[335,235,135,255],[205,465,470,155]], bumpers: [[540,151,28],[630,151,28]] },
  { par: 4, label: "Roundabout", fairways: [[110,80,240,495],[325,80,500,165],[595,220,230,355]], bumpers: [[230,300,31],[710,330,38]] },
  { par: 4, label: "Back Nine Bend", fairways: [[110,390,730,205],[110,80,195,335],[280,80,560,170]], bumpers: [[405,488,35],[565,488,35],[690,165,32]] }
]

const initialState: UiState = {
  hole: 0,
  strokes: 0,
  totalStrokes: 0,
  phase: "placing",
  message: "Tap inside the striped tee area to place your ball.",
  instructionsVisible: true
}
const gameState = Atom.make<UiState>(initialState)
const registry = AtomRegistry.make()

const canvas = document.querySelector<HTMLCanvasElement>("#course")!
const courseCard = document.querySelector<HTMLElement>(".course-card")!
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
let inactivityHelpTimer: number | undefined
let soundEnabled = DEFAULT_SOUND_ENABLED
let audioContext: AudioContext | undefined
const courseBitmaps: Array<CanvasImageSource | undefined> = new Array(courses.length)
const touchPointers = new Map<number, Point>()
const viewport: Viewport = { x: WIDTH / 2, y: HEIGHT / 2, zoom: 1 }
let pinchGesture: PinchGesture | null = null
let suppressTouchActions = false
let pendingPlacement: { pointerId: number; start: Point; moved: boolean } | null = null
let viewportUserAdjusted = false
let pendingResizeFrame = 0

const updateState = (patch: Partial<UiState>) => registry.update(gameState, current => ({ ...current, ...patch }))

registry.subscribe(gameState, state => {
  const course = courses[state.hole] ?? courses[0]!
  holeValue.textContent = `${state.hole + 1} / ${courses.length}`
  parValue.textContent = String(course.par)
  strokeValue.textContent = String(state.strokes)
  instruction.textContent = state.message
  stepNumber.textContent = state.phase === "placing" ? "1" : state.phase === "finished" ? "✓" : "2"
  tutorial.classList.toggle("done", !state.instructionsVisible || state.phase === "rolling" || state.phase === "sunk" || state.phase === "finished")
  if (state.phase === "sunk" || state.phase === "finished") {
    toast.textContent = state.phase === "finished" ? `Round complete · ${state.totalStrokes} strokes` : state.strokes <= course.par ? "Nice putt!" : "In the cup!"
    toast.classList.add("visible")
  } else {
    toast.classList.remove("visible")
  }
}, { immediate: true })

function canvasScreenPoint(event: PointerEvent): Point {
  const bounds = canvas.getBoundingClientRect()
  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top
  }
}

function baseCssScale(bounds: DOMRect): number {
  return Math.min(bounds.width / WIDTH, bounds.height / HEIGHT)
}

function worldPointFromScreen(point: Point, bounds: DOMRect): Point {
  const scale = baseCssScale(bounds) * viewport.zoom
  return {
    x: viewport.x + (point.x - bounds.width / 2) / scale,
    y: viewport.y + (point.y - bounds.height / 2) / scale
  }
}

function canvasPoint(event: PointerEvent): Point {
  return worldPointFromScreen(canvasScreenPoint(event), canvas.getBoundingClientRect())
}

function clampViewport(bounds = canvas.getBoundingClientRect()): void {
  const baseScale = baseCssScale(bounds)
  if (baseScale <= 0) return
  if (viewport.zoom <= 1.001) {
    viewport.x = WIDTH / 2
    viewport.y = HEIGHT / 2
    return
  }
  viewport.x = Math.max(0, Math.min(WIDTH, viewport.x))
  viewport.y = Math.max(0, Math.min(HEIGHT, viewport.y))
}

function resetViewport(): void {
  const bounds = canvas.getBoundingClientRect()
  const compact = window.matchMedia("(max-width: 900px), (max-height: 600px)").matches
  const fitScale = baseCssScale(bounds)
  const coverScale = Math.max(bounds.width / WIDTH, bounds.height / HEIGHT)
  viewport.zoom = compact && fitScale > 0 ? Math.max(1, Math.min(3.5, coverScale / fitScale)) : 1
  viewport.x = compact ? (wasm.getTeeLeft() + wasm.getTeeRight()) / 2 : WIDTH / 2
  viewport.y = compact ? (wasm.getTeeTop() + wasm.getTeeBottom()) / 2 : HEIGHT / 2
  viewportUserAdjusted = false
  clampViewport(bounds)
}

function resizeCanvas(): void {
  const bounds = canvas.getBoundingClientRect()
  const density = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, Math.round(bounds.width * density))
  const height = Math.max(1, Math.round(bounds.height * density))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
    clampViewport(bounds)
  }
}

function drawRoundedRect(ctx: DrawingContext, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, radius)
}

function renderStaticCourse(staticContext: DrawingContext, course: Course): void {
  staticContext.fillStyle = "#344139"
  staticContext.fillRect(0, 0, WIDTH, HEIGHT)

  const groundGradient = staticContext.createRadialGradient(WIDTH * .45, HEIGHT * .5, 20, WIDTH * .45, HEIGHT * .5, 630)
  groundGradient.addColorStop(0, "#4b5947")
  groundGradient.addColorStop(1, "#303a34")
  staticContext.fillStyle = groundGradient
  staticContext.fillRect(0, 0, WIDTH, HEIGHT)

  staticContext.save()
  staticContext.shadowColor = "rgba(0,0,0,.36)"
  staticContext.shadowBlur = 22
  staticContext.shadowOffsetY = 10
  staticContext.fillStyle = "#b97b3e"
  staticContext.strokeStyle = "#dda45c"
  staticContext.lineWidth = 18
  for (const [x,y,w,h] of course.fairways) {
    drawRoundedRect(staticContext, x, y, w, h, 9)
    staticContext.fill()
    staticContext.stroke()
  }
  staticContext.restore()

  staticContext.fillStyle = "#2eab65"
  staticContext.strokeStyle = "#5ac87e"
  staticContext.lineWidth = 2
  for (const [x,y,w,h] of course.fairways) {
    drawRoundedRect(staticContext, x + 9, y + 9, w - 18, h - 18, 4)
    staticContext.fill()
    staticContext.stroke()
  }

  staticContext.save()
  staticContext.globalAlpha = .12
  staticContext.strokeStyle = "#f0ffe6"
  staticContext.lineWidth = 1
  for (let x = -HEIGHT; x < WIDTH + HEIGHT; x += 18) {
    staticContext.beginPath(); staticContext.moveTo(x, 0); staticContext.lineTo(x + HEIGHT, HEIGHT); staticContext.stroke()
  }
  staticContext.restore()

  const teeLeft = wasm.getTeeLeft()
  const teeTop = wasm.getTeeTop()
  const teeWidth = wasm.getTeeRight() - teeLeft
  const teeHeight = wasm.getTeeBottom() - teeTop
  const teePattern = staticContext.createLinearGradient(teeLeft, teeTop, teeLeft + teeWidth, teeTop)
  teePattern.addColorStop(0, "rgba(12,92,55,.60)")
  teePattern.addColorStop(.5, "rgba(19,114,67,.35)")
  teePattern.addColorStop(1, "rgba(12,92,55,.60)")
  staticContext.fillStyle = teePattern
  drawRoundedRect(staticContext, teeLeft, teeTop, teeWidth, teeHeight, 8)
  staticContext.fill()
  staticContext.strokeStyle = "rgba(226,255,199,.58)"
  staticContext.lineWidth = 1.5
  staticContext.setLineDash([7, 7])
  staticContext.stroke()
  staticContext.setLineDash([])

  for (const [x,y,radius] of course.bumpers) drawBumper(staticContext, x, y, radius)
  drawHole(staticContext, wasm.getHoleX(), wasm.getHoleY())

  staticContext.fillStyle = "rgba(244,240,220,.86)"
  staticContext.font = "700 12px 'DM Sans', sans-serif"
  staticContext.letterSpacing = "1px"
  staticContext.fillText(course.label.toUpperCase(), 25, 34)
}

function getCourseBitmap(hole: number, course: Course): CanvasImageSource {
  const cached = courseBitmaps[hole]
  if (cached) return cached

  const cacheWidth = WIDTH * COURSE_CACHE_SCALE
  const cacheHeight = HEIGHT * COURSE_CACHE_SCALE
  const surface: HTMLCanvasElement | OffscreenCanvas = typeof OffscreenCanvas === "undefined"
    ? document.createElement("canvas")
    : new OffscreenCanvas(cacheWidth, cacheHeight)
  surface.width = cacheWidth
  surface.height = cacheHeight
  const staticContext = surface.getContext("2d", { alpha: false }) as DrawingContext | null
  if (!staticContext) throw new Error("Unable to create the course cache")
  staticContext.setTransform(COURSE_CACHE_SCALE, 0, 0, COURSE_CACHE_SCALE, 0, 0)
  renderStaticCourse(staticContext, course)

  const bitmap: CanvasImageSource = typeof OffscreenCanvas !== "undefined" && surface instanceof OffscreenCanvas
    ? surface.transferToImageBitmap()
    : surface
  courseBitmaps[hole] = bitmap
  return bitmap
}

function invalidateCourseBitmaps(): void {
  for (let hole = 0; hole < courseBitmaps.length; hole += 1) {
    const bitmap = courseBitmaps[hole]
    if (typeof ImageBitmap !== "undefined" && bitmap instanceof ImageBitmap) bitmap.close()
    courseBitmaps[hole] = undefined
  }
}

function drawCourse(): void {
  resizeCanvas()
  const baseScale = Math.min(canvas.width / WIDTH, canvas.height / HEIGHT)
  const scale = baseScale * viewport.zoom
  const translateX = canvas.width / 2 - viewport.x * scale
  const translateY = canvas.height / 2 - viewport.y * scale
  const state = registry.get(gameState)
  const course = courses[state.hole] ?? courses[0]!

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.fillStyle = "#303a34"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.setTransform(scale, 0, 0, scale, translateX, translateY)
  context.drawImage(getCourseBitmap(state.hole, course), 0, 0, WIDTH, HEIGHT)

  if (wasm.isPlaced()) drawBall(wasm.getBallX(), wasm.getBallY(), wasm.isSunk() === 1)
  if (aimPoint && state.phase === "aiming") drawAim(aimPoint)
}

function drawBumper(ctx: DrawingContext, x: number, y: number, radius: number): void {
  ctx.save()
  ctx.shadowColor = "rgba(0,0,0,.34)"
  ctx.shadowBlur = 8
  ctx.shadowOffsetY = 5
  const gradient = ctx.createRadialGradient(x - radius * .35, y - radius * .42, 2, x, y, radius)
  gradient.addColorStop(0, "#f1eee5")
  gradient.addColorStop(.65, "#bbbcb8")
  gradient.addColorStop(1, "#767d78")
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawHole(ctx: DrawingContext, x: number, y: number): void {
  const gradient = ctx.createRadialGradient(x - 3, y - 3, 1, x, y, 16)
  gradient.addColorStop(0, "#050807")
  gradient.addColorStop(.72, "#0c1410")
  gradient.addColorStop(1, "rgba(0,0,0,.3)")
  ctx.fillStyle = gradient
  ctx.beginPath(); ctx.ellipse(x, y, 15, 11, 0, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = "rgba(255,255,255,.28)"; ctx.lineWidth = 1; ctx.stroke()
  ctx.strokeStyle = "#f7f3df"; ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y - 59); ctx.stroke()
  ctx.fillStyle = "#ef7f49"
  ctx.beginPath(); ctx.moveTo(x + 1, y - 58); ctx.lineTo(x + 38, y - 46); ctx.lineTo(x + 1, y - 35); ctx.closePath(); ctx.fill()
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

function playTone(frequency: number, duration = .08, type: OscillatorType = "sine", volume = .07, delay = 0): void {
  if (!soundEnabled) return
  audioContext ??= new AudioContext()
  if (audioContext.state === "suspended") void audioContext.resume()
  const startAt = audioContext.currentTime + delay
  const oscillator = audioContext.createOscillator()
  const gain = audioContext.createGain()
  oscillator.type = type
  oscillator.frequency.value = frequency
  gain.gain.setValueAtTime(.001, startAt)
  gain.gain.linearRampToValueAtTime(volume, startAt + .004)
  gain.gain.exponentialRampToValueAtTime(.001, startAt + duration)
  oscillator.connect(gain).connect(audioContext.destination)
  oscillator.start(startAt)
  oscillator.stop(startAt + duration)
}

function playPlacementSound(): void {
  playTone(420, .065, "sine", .055)
  playTone(680, .05, "sine", .025, .022)
}

function playPuttSound(): void {
  playTone(145, .085, "triangle", .09)
  playTone(82, .065, "sine", .045, .01)
}

function showInstructionsAfterInactivity(): void {
  const state = registry.get(gameState)
  if (state.phase === "placing" || state.phase === "ready" || state.phase === "aiming") {
    updateState({ instructionsVisible: true })
    return
  }
  inactivityHelpTimer = window.setTimeout(showInstructionsAfterInactivity, 5_000)
}

function scheduleInactivityHelp(): void {
  window.clearTimeout(inactivityHelpTimer)
  inactivityHelpTimer = window.setTimeout(showInstructionsAfterInactivity, INACTIVITY_HELP_DELAY)
}

function recordActivity(): void {
  const state = registry.get(gameState)
  if (state.hole > 0 && state.instructionsVisible) updateState({ instructionsVisible: false })
  scheduleInactivityHelp()
}

function startHole(hole: number, totalStrokes: number): void {
  window.clearTimeout(holeAdvanceTimer)
  wasm.reset(hole)
  aimPoint = null
  resetViewport()
  lastUiStroke = -1
  updateState({
    hole,
    strokes: 0,
    totalStrokes,
    phase: "placing",
    message: "Tap inside the striped tee area to place your ball.",
    instructionsVisible: hole === 0
  })
  scheduleInactivityHelp()
}

function cancelAimForGesture(): void {
  if (activePointer === null) return
  activePointer = null
  aimPoint = null
  if (registry.get(gameState).phase === "aiming") {
    updateState({ phase: "ready", message: "Press the ball, drag back, then release to putt." })
  }
}

function startPinchGesture(): void {
  const points = Array.from(touchPointers.values())
  const first = points[0]
  const second = points[1]
  if (!first || !second) return
  const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
  pinchGesture = {
    startDistance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    startZoom: viewport.zoom,
    anchorWorld: worldPointFromScreen(midpoint, canvas.getBoundingClientRect())
  }
  suppressTouchActions = true
  pendingPlacement = null
  cancelAimForGesture()
}

function movePinchGesture(): void {
  if (!pinchGesture) return
  const points = Array.from(touchPointers.values())
  const first = points[0]
  const second = points[1]
  if (!first || !second) return
  const bounds = canvas.getBoundingClientRect()
  const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
  const distance = Math.hypot(second.x - first.x, second.y - first.y)
  viewport.zoom = Math.max(1, Math.min(3.5, pinchGesture.startZoom * distance / pinchGesture.startDistance))
  viewportUserAdjusted = true
  const scale = baseCssScale(bounds) * viewport.zoom
  viewport.x = pinchGesture.anchorWorld.x - (midpoint.x - bounds.width / 2) / scale
  viewport.y = pinchGesture.anchorWorld.y - (midpoint.y - bounds.height / 2) / scale
  clampViewport(bounds)
}

function placeBall(point: Point): void {
  if (wasm.place(point.x, point.y)) {
    playPlacementSound()
    updateState({ phase: "ready", message: "Press the ball, drag back, then release to putt." })
  }
}

canvas.addEventListener("pointerdown", event => {
  recordActivity()
  const isTouch = event.pointerType === "touch"
  if (isTouch) {
    event.preventDefault()
    touchPointers.set(event.pointerId, canvasScreenPoint(event))
    canvas.setPointerCapture(event.pointerId)
    if (touchPointers.size >= 2) {
      startPinchGesture()
      return
    }
  }

  if (activePointer !== null) return
  const state = registry.get(gameState)
  const point = canvasPoint(event)
  if (state.phase === "placing") {
    if (isTouch) {
      pendingPlacement = { pointerId: event.pointerId, start: canvasScreenPoint(event), moved: false }
    } else {
      placeBall(point)
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
  if (event.pointerType === "touch" && touchPointers.has(event.pointerId)) {
    event.preventDefault()
    const screenPoint = canvasScreenPoint(event)
    touchPointers.set(event.pointerId, screenPoint)
    if (pinchGesture && touchPointers.size >= 2) {
      movePinchGesture()
      return
    }
    if (pendingPlacement?.pointerId === event.pointerId && Math.hypot(screenPoint.x - pendingPlacement.start.x, screenPoint.y - pendingPlacement.start.y) > 12) {
      pendingPlacement.moved = true
    }
    if (suppressTouchActions) return
  }
  if (event.pointerId !== activePointer) return
  event.preventDefault()
  aimPoint = canvasPoint(event)
})

function finishAim(event: PointerEvent, cancelled = false): void {
  if (event.pointerId !== activePointer) return
  const point = canvasPoint(event)
  const pullX = wasm.getBallX() - point.x
  const pullY = wasm.getBallY() - point.y
  activePointer = null
  aimPoint = null
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  if (cancelled) {
    updateState({ phase: "ready", message: "Press the ball, drag back, then release to putt." })
    return
  }
  if (wasm.shoot(pullX, pullY)) {
    playPuttSound()
    updateState({ strokes: wasm.getStrokes(), phase: "rolling", message: "Let it roll…" })
  } else {
    updateState({ phase: "ready", message: "Press the ball and pull back a little farther." })
  }
}

function endPointer(event: PointerEvent, cancelled: boolean): void {
  if (event.pointerType === "touch") {
    const wasSuppressed = suppressTouchActions
    touchPointers.delete(event.pointerId)
    if (touchPointers.size < 2) pinchGesture = null
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    if (wasSuppressed) {
      if (touchPointers.size === 0) suppressTouchActions = false
      return
    }
    if (pendingPlacement?.pointerId === event.pointerId) {
      const shouldPlace = !cancelled && !pendingPlacement.moved
      pendingPlacement = null
      if (shouldPlace) placeBall(canvasPoint(event))
      return
    }
  }
  finishAim(event, cancelled)
}

canvas.addEventListener("pointerup", event => endPointer(event, false))
canvas.addEventListener("pointercancel", event => endPointer(event, true))

resetButton.addEventListener("click", () => {
  recordActivity()
  const state = registry.get(gameState)
  startHole(state.hole, state.totalStrokes)
})

soundButton.addEventListener("click", () => {
  recordActivity()
  soundEnabled = !soundEnabled
  soundButton.textContent = soundEnabled ? "Sound on" : "Sound off"
  soundButton.setAttribute("aria-pressed", String(soundEnabled))
  if (soundEnabled) playTone(440, .05)
})

function handleViewportResize(): void {
  cancelAnimationFrame(pendingResizeFrame)
  pendingResizeFrame = requestAnimationFrame(() => {
    resizeCanvas()
    if (!viewportUserAdjusted && wasm) resetViewport()
    else clampViewport()
  })
}

window.addEventListener("resize", handleViewportResize)
window.addEventListener("orientationchange", handleViewportResize)
window.visualViewport?.addEventListener("resize", handleViewportResize)
new ResizeObserver(handleViewportResize).observe(courseCard)

function followRollingBall(): void {
  if (viewport.zoom <= 1.001 || pinchGesture || suppressTouchActions) return
  const bounds = canvas.getBoundingClientRect()
  const scale = baseCssScale(bounds) * viewport.zoom
  if (scale <= 0) return

  const safeHalfWidth = bounds.width / scale * 0.25
  const safeHalfHeight = bounds.height / scale * 0.25
  const ballX = wasm.getBallX()
  const ballY = wasm.getBallY()

  if (ballX < viewport.x - safeHalfWidth) viewport.x = ballX + safeHalfWidth
  else if (ballX > viewport.x + safeHalfWidth) viewport.x = ballX - safeHalfWidth

  if (ballY < viewport.y - safeHalfHeight) viewport.y = ballY + safeHalfHeight
  else if (ballY > viewport.y + safeHalfHeight) viewport.y = ballY - safeHalfHeight

  clampViewport(bounds)
}

function frame(now: number): void {
  const deltaSeconds = (now - lastFrame) / 1000
  wasm.step(deltaSeconds)
  lastFrame = now

  const strokes = wasm.getStrokes()
  if (strokes !== lastUiStroke) {
    lastUiStroke = strokes
    updateState({ strokes })
  }

  const state = registry.get(gameState)
  const moving = wasm.isMoving() === 1
  if (state.phase === "rolling" && moving) followRollingBall()
  if (state.phase === "rolling" && !moving && !wasm.isSunk()) {
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
  resetViewport()
  scheduleInactivityHelp()
  void document.fonts.ready.then(invalidateCourseBitmaps)
  requestAnimationFrame(frame)
}

boot().catch(error => {
  console.error(error)
  loading.textContent = "The course could not be loaded. Please refresh and try again."
})
