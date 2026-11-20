import { describe, expect, it } from 'vitest';
import { limitMessage } from './supabase';

describe('limit messages', () => {
  it('explains how much is left', () => {
    expect(limitMessage('ERROR: limit_exceeded:stake:day:500')).toBe('That would go over your daily stake limit. You can stake up to $5.00 more today.');
    expect(limitMessage('limit_exceeded:deposit:month:2000')).toBe('That would go over your monthly deposit limit. You can deposit up to $20.00 more this month.');
    expect(limitMessage('limit_exceeded:loss:week:0')).toBe('You’ve reached your weekly loss limit. It frees up on a rolling basis.');
  });
  it('ignores other errors', () => {
    expect(limitMessage('insufficient_funds')).toBeNull();
  });
});
