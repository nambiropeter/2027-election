const Redis = require("ioredis");
const { config } = require("./config");

const redisOptions = {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
};

if (config.redisPassword) {
  redisOptions.password = config.redisPassword;
}

if (config.redisTls || config.redisUrl.startsWith("rediss://")) {
  redisOptions.tls = {};
}

const redis = new Redis(config.redisUrl, redisOptions);

module.exports = { redis };
