const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')

// Generate a WAV file with a sine tone
function generateToneWav(freq, durationMs) {
    const sampleRate = 44100
    const numSamples = Math.floor(sampleRate * durationMs / 1000)
    const dataSize = numSamples * 2 // 16-bit mono
    const fileSize = 44 + dataSize

    const buf = Buffer.alloc(fileSize)
    // WAV header
    buf.write('RIFF', 0); buf.writeUInt32LE(fileSize - 8, 4)
    buf.write('WAVE', 8); buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20) // PCM
    buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24)
    buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32)
    buf.writeUInt16LE(16, 34); buf.write('data', 36)
    buf.writeUInt32LE(dataSize, 40)

    // Sine wave samples
    for (let i = 0; i < numSamples; i++) {
        const sample = Math.floor(20000 * Math.sin(2 * Math.PI * freq * i / sampleRate))
        buf.writeInt16LE(sample, 44 + i * 2)
    }
    return buf
}

// Pre-generate tone files on startup
const TONE_DIR = '/tmp/mykeybox-tones'
if (!fs.existsSync(TONE_DIR)) fs.mkdirSync(TONE_DIR, { recursive: true })

function getToneFile(freq, durationMs) {
    const file = path.join(TONE_DIR, `tone_${freq}_${durationMs}.wav`)
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, generateToneWav(freq, durationMs))
    }
    return file
}

// Detect audio device: prefer USB audio (card 1), fallback to default
let AUDIO_DEVICE = 'plughw:1,0'

const PATTERNS = {
    doorOpen: [
        { freq: 2500, duration: 200 },
        { pause: 100 },
        { freq: 2500, duration: 200 },
    ],
    doorClosed: [
        { freq: 1500, duration: 250 },
    ],
    error: [
        { freq: 3000, duration: 100 },
        { pause: 80 },
        { freq: 3000, duration: 100 },
        { pause: 80 },
        { freq: 3000, duration: 100 },
    ],
    success: [
        { freq: 2000, duration: 200 },
        { pause: 50 },
        { freq: 2500, duration: 200 },
    ],
}

const REPEAT_INTERVAL = 2000
const _activeAlarms = {}

function beep(freq, durationMs) {
    return new Promise((resolve) => {
        const file = getToneFile(freq, durationMs)
        exec(`aplay -D ${AUDIO_DEVICE} -q "${file}" 2>/dev/null || aplay -q "${file}" 2>/dev/null`, { timeout: durationMs + 1000 }, () => resolve())
    })
}

async function play(patternName) {
    const pattern = PATTERNS[patternName]
    if (!pattern) return
    try {
        for (const step of pattern) {
            if (step.pause) {
                await new Promise(r => setTimeout(r, step.pause))
            } else {
                await beep(step.freq, step.duration)
            }
        }
    } catch (err) {
        console.error('[BUZZER] play failed:', err.message)
    }
}

function startDoorAlarm(doorIndex) {
    if (_activeAlarms[doorIndex]) return
    console.log(`[BUZZER] Door ${doorIndex + 1} alarm ON`)
    play('doorOpen')
    _activeAlarms[doorIndex] = setInterval(() => play('doorOpen'), REPEAT_INTERVAL)
}

function stopDoorAlarm(doorIndex) {
    if (!_activeAlarms[doorIndex]) return
    clearInterval(_activeAlarms[doorIndex])
    delete _activeAlarms[doorIndex]
    console.log(`[BUZZER] Door ${doorIndex + 1} alarm OFF`)
    play('doorClosed')
}

// Pre-generate common tones
;[1500, 2000, 2500, 3000].forEach(f => { [100, 200, 250].forEach(d => getToneFile(f, d)) })
console.log('[BUZZER] Audio device:', AUDIO_DEVICE)

module.exports = { beep, play, startDoorAlarm, stopDoorAlarm, PATTERNS }
