require('dotenv').config()
const fetch = require('node-fetch')
const Web3Utils = require('web3-utils')
const { web3Home, web3Foreign } = require('../services/web3')
const { bridgeConfig } = require('../../config/base.config')
const logger = require('../services/logger').child({
  module: 'gasPrice'
})
const { setIntervalAndRun } = require('../utils/utils')
const {
  DEFAULT_UPDATE_INTERVAL,
  GAS_PRICE_BOUNDARIES,
  GAS_PRICE_OPTIONS
} = require('../utils/constants')

const HomeABI = bridgeConfig.homeBridgeAbi
const ForeignABI = bridgeConfig.foreignBridgeAbi

const {
  FOREIGN_BRIDGE_ADDRESS,
  FOREIGN_GAS_PRICE_FALLBACK,
  FOREIGN_GAS_PRICE_ORACLE_URL,
  FOREIGN_GAS_PRICE_SPEED_TYPE,
  FOREIGN_GAS_PRICE_UPDATE_INTERVAL,
  HOME_BRIDGE_ADDRESS,
  HOME_GAS_PRICE_FALLBACK,
  HOME_GAS_PRICE_ORACLE_URL,
  HOME_GAS_PRICE_SPEED_TYPE,
  HOME_GAS_PRICE_UPDATE_INTERVAL
} = process.env

const homeBridge = new web3Home.eth.Contract(HomeABI, HOME_BRIDGE_ADDRESS)

const foreignBridge = new web3Foreign.eth.Contract(ForeignABI, FOREIGN_BRIDGE_ADDRESS)

let cachedGasPrice = null
let cachedGasPriceOracleSpeeds = null

function gasPriceWithinLimits(gasPrice) {
  if (gasPrice < GAS_PRICE_BOUNDARIES.MIN) {
    return GAS_PRICE_BOUNDARIES.MIN
  } else if (gasPrice > GAS_PRICE_BOUNDARIES.MAX) {
    return GAS_PRICE_BOUNDARIES.MAX
  } else {
    return gasPrice
  }
}

async function fetchGasPriceFromOracle(oracleUrl, speedType) {
  const response = await fetch(oracleUrl)
  const json = await response.json()
  const oracleGasPrice = json[speedType]
  if (!oracleGasPrice) {
    throw new Error(`Response from Oracle didn't include gas price for ${speedType} type.`)
  }
  const gasPrice = gasPriceWithinLimits(oracleGasPrice)
  return {
    oracleGasPrice: Web3Utils.toWei(gasPrice.toString(), 'gwei'),
    oracleResponse: json
  }
}

async function fetchGasPrice({ bridgeContract, oracleFn }) {
  let gasPrice = null
  let oracleGasPriceSpeeds = null
  try {
    const { oracleGasPrice, oracleResponse } = await oracleFn()
    gasPrice = oracleGasPrice
    oracleGasPriceSpeeds = oracleResponse
    logger.debug({ gasPrice }, 'Gas price updated using the oracle')
  } catch (e) {
    logger.error(`Gas Price API is not available. ${e.message}`)

    try {
      gasPrice = await bridgeContract.methods.gasPrice().call()
      logger.debug({ gasPrice }, 'Gas price updated using the contracts')
    } catch (e) {
      logger.error(`There was a problem getting the gas price from the contract. ${e.message}`)
    }
  }
  return {
    gasPrice,
    oracleGasPriceSpeeds
  }
}

let fetchGasPriceInterval = null

async function start(chainId) {
  clearInterval(fetchGasPriceInterval)

  let bridgeContract = null
  let oracleUrl = null
  let speedType = null
  let updateInterval = null
  if (chainId === 'home') {
    bridgeContract = homeBridge
    oracleUrl = HOME_GAS_PRICE_ORACLE_URL
    speedType = HOME_GAS_PRICE_SPEED_TYPE
    updateInterval = HOME_GAS_PRICE_UPDATE_INTERVAL || DEFAULT_UPDATE_INTERVAL

    cachedGasPrice = HOME_GAS_PRICE_FALLBACK
  } else if (chainId === 'foreign') {
    bridgeContract = foreignBridge
    oracleUrl = FOREIGN_GAS_PRICE_ORACLE_URL
    speedType = FOREIGN_GAS_PRICE_SPEED_TYPE
    updateInterval = FOREIGN_GAS_PRICE_UPDATE_INTERVAL || DEFAULT_UPDATE_INTERVAL

    cachedGasPrice = FOREIGN_GAS_PRICE_FALLBACK
  } else {
    throw new Error(`Unrecognized chainId '${chainId}'`)
  }

  fetchGasPriceInterval = setIntervalAndRun(async () => {
    const { gasPrice, oracleGasPriceSpeeds } = await fetchGasPrice({
      bridgeContract,
      oracleFn: () => fetchGasPriceFromOracle(oracleUrl, speedType)
    })
    cachedGasPrice = gasPrice || cachedGasPrice
    cachedGasPriceOracleSpeeds = oracleGasPriceSpeeds || cachedGasPriceOracleSpeeds
  }, updateInterval)
}

function getPrice(options) {
  return processGasPriceOptions({ options, cachedGasPrice, cachedGasPriceOracleSpeeds })
}

function processGasPriceOptions({ options, cachedGasPrice, cachedGasPriceOracleSpeeds }) {
  let gasPrice = cachedGasPrice
  if (options && options.type && options.value) {
    if (options.type === GAS_PRICE_OPTIONS.GAS_PRICE) {
      return options.value
    } else if (options.type === GAS_PRICE_OPTIONS.SPEED) {
      const speedOption = cachedGasPriceOracleSpeeds[options.value]
      gasPrice = speedOption ? Web3Utils.toWei(speedOption.toString(), 'gwei') : cachedGasPrice
    }
  }
  return gasPrice
}

module.exports = {
  start,
  fetchGasPrice,
  getPrice,
  processGasPriceOptions,
  gasPriceWithinLimits
}
