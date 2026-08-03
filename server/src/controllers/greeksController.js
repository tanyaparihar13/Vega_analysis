const greeksService = require('../services/greeksService');

// POST /api/greeks/calculate — single contract, called explicitly by the client
// (e.g. a "Calculate" button), never on an automatic timer or tick handler.
async function calculateGreeks(req, res) {
  try {
    const result = greeksService.calculateForContract(req.body);
    res.json({ result });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

// POST /api/greeks/calculate-batch — whole strike list in one manual call.
// body: { spot, expiryDate | daysToExpiry, riskFreeRate?, contracts: [{ strike, iv, optionType }] }
async function calculateGreeksBatch(req, res) {
  try {
    const results = greeksService.calculateForChain(req.body);
    res.json({ results });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

module.exports = { calculateGreeks, calculateGreeksBatch };
