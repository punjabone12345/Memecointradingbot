import { Router } from 'express';
import {
  getSniperStatus,
  manualCloseSniperPosition,
  editSniperPositionFields,
  deleteSniperPositionById,
  editClosedSniperPositionById,
  deleteClosedSniperPositionById,
} from '../services/sniper-engine.service.js';

const router = Router();

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', (_req, res) => {
  res.json(getSniperStatus());
});

// ── Open position management ──────────────────────────────────────────────────

/** Close an open sniper position at its last known price */
router.post('/:id/close', async (req, res) => {
  const { reason } = req.body as { reason?: string };
  const ok = await manualCloseSniperPosition(req.params.id, reason?.trim() || 'Manual close');
  if (!ok) { res.status(404).json({ error: 'Position not found or already closed' }); return; }
  res.json({ success: true });
});

/** Edit fields of an open sniper position (entryPrice, currentSLPrice, triggerAmountUsd) */
router.patch('/:id', (req, res) => {
  const updates = req.body as { entryPrice?: number; currentSLPrice?: number; triggerAmountUsd?: number };
  const pos = editSniperPositionFields(req.params.id, updates);
  if (!pos) { res.status(404).json({ error: 'Position not found' }); return; }
  res.json(pos);
});

/** Delete an open sniper position and refund remaining SOL to balance */
router.delete('/:id', async (req, res) => {
  const ok = await deleteSniperPositionById(req.params.id);
  if (!ok) { res.status(404).json({ error: 'Position not found' }); return; }
  res.json({ success: true });
});

// ── Closed position management ────────────────────────────────────────────────

/** Edit a closed sniper position (closeReason, closePnlPct) */
router.patch('/closed/:id', async (req, res) => {
  const updates = req.body as { closeReason?: string; closePnlPct?: number };
  const pos = await editClosedSniperPositionById(req.params.id, updates);
  if (!pos) { res.status(404).json({ error: 'Closed position not found' }); return; }
  res.json(pos);
});

/** Delete a closed sniper position record */
router.delete('/closed/:id', async (req, res) => {
  const ok = await deleteClosedSniperPositionById(req.params.id);
  if (!ok) { res.status(404).json({ error: 'Closed position not found' }); return; }
  res.json({ success: true });
});

export default router;
