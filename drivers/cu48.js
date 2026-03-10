const BaseDriver = require('./base')

// CU48 commands for up to 48 doors
// Query: 02 00 00 50 03 55
// Open door N: 02 00 [N] 51 03 [checksum]
// Response: 02 00 00 65 [D1][D2][D3][D4][D5][D6] 03 [checksum] (12 bytes)

class CU48Driver extends BaseDriver {
    constructor(doorCount, serialPort, baudRate) {
        super(doorCount)
        this.serialPortPath = serialPort
        this.baudRate = baudRate
        this.port = null
        this.parser = null
        this.lastResponseTime = 0
    }

    async initialize() {
        const { SerialPort } = require('serialport')
        const { ByteLengthParser } = require('@serialport/parser-byte-length')

        try {
            this.port = new SerialPort({ path: this.serialPortPath, baudRate: this.baudRate })
            this.parser = this.port.pipe(new ByteLengthParser({ length: 12 }))

            this.parser.on('data', (data) => {
                this._parseResponse(data)
            })

            this.port.on('error', (err) => {
                console.log('[CU48] Serial error:', err.message)
                this.connected = false
            })

            this.connected = true
            console.log(`[CU48] Connected on ${this.serialPortPath} @ ${this.baudRate}`)

            // Poll door states every 1 second
            this._pollInterval = setInterval(() => {
                if (this.port && this.port.isOpen) {
                    this._sendQuery()
                }
            }, 1000)

        } catch (err) {
            console.log('[CU48] Failed to connect:', err.message)
            this.connected = false
        }
    }

    _sendQuery() {
        // Query all 48 locks: 02 00 00 50 03 55
        const buf = Buffer.from([0x02, 0x00, 0x00, 0x50, 0x03, 0x55])
        this.port.write(buf)
    }

    _parseResponse(data) {
        const pairs = data.toString('hex').match(/.{1,2}/g)
        if (pairs[0] !== '02' || pairs[10] !== '03') return

        this.lastResponseTime = Date.now()
        this.connected = true

        // Parse 6 data bytes (D1-D6) → 48 lock states
        for (let byteIdx = 4; byteIdx <= 9; byteIdx++) {
            const b = parseInt(pairs[byteIdx], 16)
            for (let bit = 0; bit < 8; bit++) {
                const doorIdx = (byteIdx - 4) * 8 + bit
                if (doorIdx < this.doorCount) {
                    this.doorStates[doorIdx] = ((b >> bit) & 1) === 1
                }
            }
        }
    }

    async openDoor(doorNumber) {
        if (!this.port || !this.port.isOpen) return false
        if (doorNumber < 0 || doorNumber >= this.doorCount) return false

        // Open command: 02 00 [doorNumber] 51 03 [checksum]
        const checksum = (0x02 + 0x00 + doorNumber + 0x51 + 0x03) & 0xFF
        const buf = Buffer.from([0x02, 0x00, doorNumber, 0x51, 0x03, checksum])

        console.log(`[CU48] Opening door ${doorNumber + 1}: ${buf.toString('hex')}`)
        this.port.write(buf)

        // Query immediately for feedback
        this._sendQuery()
        return true
    }

    async close() {
        if (this._pollInterval) clearInterval(this._pollInterval)
        if (this.port && this.port.isOpen) this.port.close()
        this.connected = false
    }
}

module.exports = CU48Driver
