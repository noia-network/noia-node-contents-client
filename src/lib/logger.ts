const winston = require("winston");

const options = {
  transports: [
    new winston.transports.Console({
      colorize: true,
      label: "noia-contents-client",
      json: false
    })
  ],
  exitOnError: false,
}

export = new winston.Logger(options)
