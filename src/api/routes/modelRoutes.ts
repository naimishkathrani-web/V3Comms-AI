import { Router, Request, Response } from 'express';
import { modelConfigService } from '../../services/ModelConfigService.js';
import { sanitizeModelConfig } from '../middleware.js';

const router = Router();

// Get full model config (cloud + local) — API keys are sanitized
router.get('/api/models', (_req: Request, res: Response) => {
  const cfg = modelConfigService.getConfig();
  res.json({
    success: true,
    cloudModels: cfg.cloudModels.map(sanitizeModelConfig),
    localModels: cfg.localModels.map(sanitizeModelConfig),
    autoMode: cfg.autoMode,
  });
});

// Get the active chain (ordered, enabled only) — API keys sanitized
router.get('/api/models/chain', (_req: Request, res: Response) => {
  res.json({ success: true, chain: modelConfigService.getActiveChain().map(sanitizeModelConfig) });
});

// Add or update a cloud model
router.post('/api/models/cloud', (req: Request, res: Response) => {
  try {
    modelConfigService.setCloudModel(req.body);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Add or update a local model
router.post('/api/models/local', (req: Request, res: Response) => {
  try {
    modelConfigService.setLocalModel(req.body);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Toggle model enabled/disabled
router.post('/api/models/toggle', (req: Request, res: Response) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  const model = modelConfigService.toggleModel(id);
  if (!model) return res.status(404).json({ error: 'Model not found' });
  res.json({ success: true, model });
});

// Delete a model
router.delete('/api/models', (req: Request, res: Response) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  const removed = modelConfigService.deleteModel(id);
  res.json({ success: removed });
});

// Reorder cloud models
router.post('/api/models/reorder/cloud', (req: Request, res: Response) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array is required' });
  modelConfigService.reorderCloud(order);
  res.json({ success: true });
});

// Reorder local models
router.post('/api/models/reorder/local', (req: Request, res: Response) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array is required' });
  modelConfigService.reorderLocal(order);
  res.json({ success: true });
});

// Set auto mode
router.post('/api/models/auto', (req: Request, res: Response) => {
  const { enabled } = req.body;
  modelConfigService.setAutoMode(!!enabled);
  res.json({ success: true, autoMode: !!enabled });
});

// Test a cloud model's API connection
router.post('/api/models/test', async (req: Request, res: Response) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  const result = await modelConfigService.testCloudModel(id);
  res.json({ success: result.ok, ...result });
});

export const modelRoutes = router;
