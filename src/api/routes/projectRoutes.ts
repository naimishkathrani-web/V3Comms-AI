import { Router, Request, Response } from 'express';
import { projectContextService } from '../../services/ProjectContextService.js';

const router = Router();

// List all projects
router.get('/api/projects', async (_req: Request, res: Response) => {
  try {
    const projects = await projectContextService.listProjects();
    res.json({ success: true, projects });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create a new project or node
router.post('/api/projects', async (req: Request, res: Response) => {
  try {
    const node = await projectContextService.createNode(req.body);
    res.json({ success: true, node });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get a specific node
router.get('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const node = await projectContextService.getNode(id);
    if (!node) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, node });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get children of a node
router.get('/api/projects/:id/children', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const children = await projectContextService.getChildren(id);
    res.json({ success: true, children });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get full tree from a root
router.get('/api/projects/:id/tree', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const tree = await projectContextService.getTree(id);
    res.json({ success: true, tree });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update a node
router.put('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const node = await projectContextService.updateNode(id, req.body);
    if (!node) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, node });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a node (cascades to children)
router.delete('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const deleted = await projectContextService.deleteNode(id);
    res.json({ success: deleted });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Search within a project
router.get('/api/projects/:id/search', async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { q, limit } = req.query;
    const results = await projectContextService.searchWithinProject(
      id,
      (q as string) || '',
      limit ? parseInt(limit as string) : 5
    );
    res.json({ success: true, results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export const projectRoutes = router;
