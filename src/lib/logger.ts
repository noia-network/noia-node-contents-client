import winston from "winston";

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

export = new winston.Logger(options);
