import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../../../src/app';

export function apiClient(pool: Pool) {
  const api = request(createApp(pool));

  const createAccount = async (name = 'Alice') => (await api.post('/accounts').send({ name })).body;

  let n = 0;
  const addTx = (accountId: string, type: 'credit' | 'debit', amount: number, reference_id = `ref-${++n}`) =>
    api
      .post(`/accounts/${accountId}/transactions`)
      .send({ type, amount, reference_id, description: `${type} ${amount}` });

  const balanceOf = async (id: string) => (await api.get(`/accounts/${id}/balance`)).body.balance;

  return { api, createAccount, addTx, balanceOf };
}

/** Every error response must follow the same envelope. */
export function expectErrorShape(body: any, code: string) {
  expect(body).toEqual({
    error: expect.objectContaining({ code, message: expect.any(String) }),
  });
}
