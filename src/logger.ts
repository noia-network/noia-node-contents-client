import * as winston from "winston";

const options = {
    transports: [
        new winston.transports.Console({
            colorize: true,
            label: "noia-contents-client",
            json: false,
            handleExceptions: true
        })
    ],
    exitOnError: false
};

export let logger = new winston.Logger(options);
