const BALL_RADIUS: f64 = 11.0
const STOP_SPEED: f64 = 4.0
const FRICTION: f64 = 0.985
const WALL_BOUNCE: f64 = 0.62

let currentHole: i32 = 0
let ballX: f64 = 0.0
let ballY: f64 = 0.0
let velocityX: f64 = 0.0
let velocityY: f64 = 0.0
let placed: bool = false
let sunk: bool = false
let strokes: i32 = 0
let collisionStrength: f64 = 0.0

function insideRect(x: f64, y: f64, left: f64, top: f64, right: f64, bottom: f64): bool {
  return x >= left + BALL_RADIUS && x <= right - BALL_RADIUS && y >= top + BALL_RADIUS && y <= bottom - BALL_RADIUS
}

function hitsCircle(x: f64, y: f64, cx: f64, cy: f64, radius: f64): bool {
  const dx = x - cx
  const dy = y - cy
  const distance = radius + BALL_RADIUS
  return dx * dx + dy * dy < distance * distance
}

function insideCourse(x: f64, y: f64): bool {
  if (currentHole == 0) {
    const green = insideRect(x, y, 205.0, 55.0, 815.0, 260.0) ||
      insideRect(x, y, 335.0, 235.0, 470.0, 490.0) ||
      insideRect(x, y, 205.0, 465.0, 675.0, 620.0)
    return green && !hitsCircle(x, y, 540.0, 151.0, 28.0) && !hitsCircle(x, y, 630.0, 151.0, 28.0)
  }

  if (currentHole == 1) {
    const green = insideRect(x, y, 110.0, 80.0, 350.0, 575.0) ||
      insideRect(x, y, 325.0, 80.0, 825.0, 245.0) ||
      insideRect(x, y, 595.0, 220.0, 825.0, 575.0)
    return green && !hitsCircle(x, y, 230.0, 300.0, 31.0) && !hitsCircle(x, y, 710.0, 330.0, 38.0)
  }

  const green = insideRect(x, y, 110.0, 390.0, 840.0, 595.0) ||
    insideRect(x, y, 110.0, 80.0, 305.0, 415.0) ||
    insideRect(x, y, 280.0, 80.0, 840.0, 250.0)
  return green && !hitsCircle(x, y, 405.0, 488.0, 35.0) && !hitsCircle(x, y, 565.0, 488.0, 35.0) && !hitsCircle(x, y, 690.0, 165.0, 32.0)
}

function teeLeft(): f64 {
  if (currentHole == 0) return 260.0
  if (currentHole == 1) return 145.0
  return 715.0
}

function teeTop(): f64 {
  if (currentHole == 0) return 520.0
  if (currentHole == 1) return 470.0
  return 455.0
}

function teeRight(): f64 {
  if (currentHole == 0) return 400.0
  if (currentHole == 1) return 285.0
  return 805.0
}

function teeBottom(): f64 {
  if (currentHole == 0) return 585.0
  if (currentHole == 1) return 545.0
  return 550.0
}

function holeX(): f64 {
  if (currentHole == 0) return 735.0
  if (currentHole == 1) return 740.0
  return 175.0
}

function holeY(): f64 {
  if (currentHole == 0) return 135.0
  if (currentHole == 1) return 500.0
  return 145.0
}

export function reset(hole: i32): void {
  currentHole = hole < 0 ? 0 : hole > 2 ? 2 : hole
  ballX = 0.0
  ballY = 0.0
  velocityX = 0.0
  velocityY = 0.0
  placed = false
  sunk = false
  strokes = 0
  collisionStrength = 0.0
}

export function place(x: f64, y: f64): i32 {
  if (placed || sunk || x < teeLeft() || x > teeRight() || y < teeTop() || y > teeBottom()) return 0
  ballX = x
  ballY = y
  placed = true
  return 1
}

export function shoot(pullX: f64, pullY: f64): i32 {
  if (!placed || sunk || isMoving() == 1) return 0
  const length = Math.sqrt(pullX * pullX + pullY * pullY)
  if (length < 7.0) return 0
  const capped = Math.min(length, 155.0)
  const scale = capped / length * 5.15
  velocityX = pullX * scale
  velocityY = pullY * scale
  strokes += 1
  return 1
}

export function step(deltaSeconds: f64): void {
  if (!placed || sunk) return
  let remaining = Math.min(deltaSeconds, 0.05)
  while (remaining > 0.0) {
    const dt = Math.min(remaining, 1.0 / 180.0)
    remaining -= dt

    const speed = Math.sqrt(velocityX * velocityX + velocityY * velocityY)
    if (speed < STOP_SPEED) {
      velocityX = 0.0
      velocityY = 0.0
      break
    }

    const nextX = ballX + velocityX * dt
    const nextY = ballY + velocityY * dt
    if (insideCourse(nextX, nextY)) {
      ballX = nextX
      ballY = nextY
    } else {
      collisionStrength = Math.max(collisionStrength, speed)
      const canMoveX = insideCourse(nextX, ballY)
      const canMoveY = insideCourse(ballX, nextY)
      if (canMoveX) {
        ballX = nextX
        velocityY = -velocityY * WALL_BOUNCE
      } else if (canMoveY) {
        ballY = nextY
        velocityX = -velocityX * WALL_BOUNCE
      } else {
        velocityX = -velocityX * WALL_BOUNCE
        velocityY = -velocityY * WALL_BOUNCE
      }
    }

    const frameFriction = Math.pow(FRICTION, dt * 60.0)
    velocityX *= frameFriction
    velocityY *= frameFriction

    const cupDx = ballX - holeX()
    const cupDy = ballY - holeY()
    if (cupDx * cupDx + cupDy * cupDy < 15.0 * 15.0 && speed < 150.0) {
      ballX = holeX()
      ballY = holeY()
      velocityX = 0.0
      velocityY = 0.0
      sunk = true
      break
    }
  }
}

export function consumeCollisionStrength(): f64 {
  const strength = collisionStrength
  collisionStrength = 0.0
  return strength
}

export function getBallX(): f64 { return ballX }
export function getBallY(): f64 { return ballY }
export function getVelocityX(): f64 { return velocityX }
export function getVelocityY(): f64 { return velocityY }
export function getStrokes(): i32 { return strokes }
export function isPlaced(): i32 { return placed ? 1 : 0 }
export function isMoving(): i32 { return Math.abs(velocityX) + Math.abs(velocityY) > STOP_SPEED ? 1 : 0 }
export function isSunk(): i32 { return sunk ? 1 : 0 }
export function getCurrentHole(): i32 { return currentHole }
export function getTeeLeft(): f64 { return teeLeft() }
export function getTeeTop(): f64 { return teeTop() }
export function getTeeRight(): f64 { return teeRight() }
export function getTeeBottom(): f64 { return teeBottom() }
export function getHoleX(): f64 { return holeX() }
export function getHoleY(): f64 { return holeY() }
