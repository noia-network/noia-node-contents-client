import Content from "./lib/content"
import EventEmitter from "events"
import MetadataStore from "./lib/metadata-store"
import fs from "fs"
import logger from "./lib/logger"
import mkdirp from "mkdirp"
import path from "path"
const speedometer = require("speedometer")

export = class ContentsClient extends EventEmitter {
  public contents: any
  public contentsNotVerified: any
  public _destroyed: boolean
  public _downloadSpeed: any
  public _uploadSpeed: any
  public dir: any
  public metadataPath: any
  public master: any
  public metadataStore: any

  constructor (master: any, dir: any) {
    super()

    this.contents = {}
    this.contentsNotVerified = {}

    if (!dir) throw new Error("unspecified dataDir")
    if (!fs.existsSync(dir)) mkdirp.sync(dir)

    this._destroyed = false
    this._downloadSpeed = speedometer(3)
    this._uploadSpeed = speedometer(3)
    this.dir = dir
    this.metadataPath = path.join(dir, "metadata.json")
    this.master = master

    Object.defineProperty(ContentsClient.prototype, "downloadSpeed", {
      get: () => { return this._downloadSpeed() }
    })
    Object.defineProperty(ContentsClient.prototype, "uploadSpeed", {
      get: () => { return this._uploadSpeed() }
    })
  }

  start () {
    this.metadataStore = new MetadataStore(this.metadataPath)
    this.metadataStore.on("added", (metadata: any) => this._add(metadata))
    this.metadataStore.on("removed", (infoHash: string) => this._remove(infoHash))
    this.metadataStore.on("notChanged", (infoHashes: string[]) => {
      const keys = Object.keys(this.contentsNotVerified)
      keys.forEach((infoHash: any) => {
        this.contentsNotVerified[infoHash].verify()
      })
    })
  }

  stop () {
    this.contents = {}
    this.metadataStore = null
  }

  add (metadata: any) {
    this.metadataStore.add(metadata)
  }

  remove (infoHash: any) {
    this.metadataStore.remove(infoHash)
  }

  get (id: any) {
    if (this._destroyed) return
    if (Array.isArray(id)) {
      const contents: string[] = []
      id.forEach(infoHash => contents.push(this.contents[infoHash]))
      return contents
    } else {
      return this.contents[id]
    }
  }

  getInfoHashes() {
    if (this._destroyed) return
    return Object.keys(this.contents)
  }

  _add (metadata: any) {
    if (this._destroyed) return
    const content = new Content(this.master, metadata, this.dir)
    this.contentsNotVerified[content.infoHash] = content
    content.on("idle", () => {
      delete this.contentsNotVerified[content.infoHash]
      this.contents[content.infoHash] = content
      this.emit("seeding", this.getInfoHashes())
    })
    content.on("downloading", () => {
      logger.info(`downloading ${content.infoHash}...`)
    })
    content.on("downloaded", (chunkSize: any) => {
      this.emit("downloaded", chunkSize)
      this._downloadSpeed(chunkSize)
    })
    content.on("uploaded", (chunkSize: any) => {
      this.emit("uploaded", chunkSize)
      this._uploadSpeed(chunkSize)
    })
  }

  _remove (infoHash: any) {
    if (this._destroyed) return
    delete this.contents[infoHash]
    this.emit("seeding", this.getInfoHashes())
  }

  destroy () {
    return new Promise((resolve) => {
      this._destroyed = true
      resolve()
    })
  }
}
