const ContentClient = require("./dist/index")
const WebSocket = require("ws")
const Wire = require("noia-protocol")

const wire = new Wire(new WebSocket("ws://localhost:7777"))
wire.once("handshake", () => {
  const client = new ContentClient({ _wire: wire }, "./storage")
  client.start()
  client.add({
    infoHash: "f8f40a6b918314b6ec7cb71d487aec1d529b163b",
    pieces: "691"
  })
  client.on("seeding", infoHashes => {
    console.log("seeding", infoHashes)
    const content = client.get("f8f40a6b918314b6ec7cb71d487aec1d529b163b")
    content.getResponseBuffer(690, null, null, (data) => {
      console.log("data")
    })
  })
  client.on("downloading", chunkSize => {
    console.log("downloading...")
  })
  client.on("downloaded", chunkSize => {
    console.log("downloaded", chunkSize, "speed", client.downloadSpeed)
  })
  client.on("uploaded", chunkSize => {
    console.log("uploaded", chunkSize, "speed", client.uploadSpeed)
  })
})
