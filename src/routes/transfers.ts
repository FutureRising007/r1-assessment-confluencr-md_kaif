import { Router } from 'express';
import { parse } from '../middleware/validate';
import { TransferService } from '../services/transferService';
import { transferSchema } from '../validation/schemas';

export function transfersRouter(transfers: TransferService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const input = parse(transferSchema, req.body);
    res.status(201).json(await transfers.transfer(input));
  });

  return router;
}
