import { Router, Request, Response } from 'express';
import { builderService } from '../../services/BuilderService.js';

const router = Router();

router.post('/api/builder/chat', async (req: Request, res: Response) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const chunk of builderService.chatStream(message)) {
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    console.error('[Builder] Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

router.get('/api/builder/tasks', (req: Request, res: Response) => {
  res.json({ tasks: builderService.getTasks() });
});

router.get('/api/builder/files', (req: Request, res: Response) => {
  const dir = (req.query.dir as string) || '.';
  res.json({ tree: builderService.getFileTree(dir) });
});

router.post('/api/builder/reset', (req: Request, res: Response) => {
  builderService.resetConversation();
  res.json({ success: true });
});

export const builderRoutes = router;
