const FSChunkStore = require("fs-chunk-store")
const ImmediateChunkStore = require("immediate-chunk-store")
const WebSocket = require("ws")
const Wire = require("noia-protocol")
const http = require("http")

const pieceLength = 32768
const length = 22610641
const path = "NOIA_Network.mp4"

const store = FSChunkStore(pieceLength, { path, length })
const server = http.createServer()
const wss = new WebSocket.Server({ server })
wss.on("connection", ws => {
    const wire = new Wire(ws)
    wire.handshake()
      .then(() => {
        const metadata = {
          infoHash: "f8f40a6b918314b6ec7cb71d487aec1d529b163b",
          pieces: "691"
        }
        wire.seed(metadata)
        wire.on("requested", info => {
          handleMessage(wire, info)
        })
      })
})
server.listen(7777, "localhost", err => {
    if (err) throw new Error(err)
    console.log("listening")
})

function handleMessage(wire, params) {
    const self = this
    const piece = params.piece
    const infoHash = params.infoHash
    if (typeof piece === 'undefined') {
        console.log(`bad request infoHash=${infoHash} index=${piece}`)
        return
    }
    store.get(piece, (err, dataBuf) => {
      if (err) throw new Error(err)
      console.log(`response infoHash=${infoHash} index=${piece} length=${dataBuf.length}`)
      const buf = responseBuffer(piece, infoHash, dataBuf)
      wire.response(buf)
    })

    function responseBuffer (part, infoHash, dataBuf) {
      const partBuf = Buffer.allocUnsafe(4)
      partBuf.writeUInt32BE(part)
      const infoHashBuf = Buffer.from(infoHash, 'hex')
      const buf = Buffer.concat([partBuf, infoHashBuf, dataBuf])
      return buf
    }
  }
