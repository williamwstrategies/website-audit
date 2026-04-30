const express = require('express');
const cors = require('cors');
const path = require('path');
const { analyzeWebsite } = require('./api/analyze');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Support debug mode via ?debug=1 or { debug: true } in body
  const debugMode = !!(req.query.debug || req.body.debug);

  try {
    const result = await analyzeWebsite(url, { debug: debugMode });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LeadCheck running on http://localhost:${PORT}`));