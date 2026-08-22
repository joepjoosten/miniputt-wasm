import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const wasmBytes = await readFile(new URL("../public/miniputt.wasm", import.meta.url))
const { instance } = await WebAssembly.instantiate(wasmBytes)
const game = instance.exports

test("a ball can only be placed in the active tee area", () => {
  game.reset(0)
  assert.equal(game.place(100, 100), 0)
  assert.equal(game.isPlaced(), 0)
  assert.equal(game.place(330, 550), 1)
  assert.equal(game.isPlaced(), 1)
  assert.equal(game.place(350, 550), 0, "the ball can only be placed once")
})

test("a valid pull starts the ball and counts one stroke", () => {
  game.reset(0)
  game.place(380, 550)
  assert.equal(game.shoot(0, 2), 0, "tiny accidental pulls are ignored")
  assert.equal(game.getStrokes(), 0)

  assert.equal(game.shoot(0, -90), 1)
  assert.equal(game.getStrokes(), 1)
  assert.equal(game.isMoving(), 1)

  const startY = game.getBallY()
  for (let frame = 0; frame < 45; frame += 1) game.step(1 / 60)
  assert.ok(game.getBallY() < startY, "the ball rolls in the pull direction")
})

test("friction eventually brings a rolling ball to rest", () => {
  game.reset(1)
  game.place(210, 515)
  game.shoot(0, -55)
  for (let frame = 0; frame < 1800 && game.isMoving(); frame += 1) game.step(1 / 60)
  assert.equal(game.isMoving(), 0)
  assert.equal(game.getStrokes(), 1)
})

test("rail and bumper impacts emit a consumable collision strength", () => {
  const impacts = [
    { hole: 0, start: [330, 550], pull: [-120, 0], label: "rail" },
    { hole: 1, start: [230, 515], pull: [0, -120], label: "bumper" }
  ]

  for (const impact of impacts) {
    game.reset(impact.hole)
    assert.equal(game.consumeCollisionStrength(), 0)
    assert.equal(game.place(...impact.start), 1)
    assert.equal(game.shoot(...impact.pull), 1)

    let strength = 0
    for (let frame = 0; frame < 240 && strength === 0; frame += 1) {
      game.step(1 / 60)
      strength = game.consumeCollisionStrength()
    }

    assert.ok(strength > 0, `${impact.label} collision emits its impact speed`)
    assert.equal(game.consumeCollisionStrength(), 0, `${impact.label} event is consumed once`)
  }
})
