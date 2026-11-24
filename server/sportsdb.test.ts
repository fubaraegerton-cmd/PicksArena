import { describe, expect, it } from 'vitest';
import { normalize, statusOf } from './sportsdb';

describe('TheSportsDB parsing', () => {
  it('maps feed status codes', () => {
    expect(statusOf('NS')).toBe('scheduled');
    expect(statusOf('FT')).toBe('final');
    expect(statusOf('AOT')).toBe('final');
    expect(statusOf('Q3')).toBe('live');
    expect(statusOf('HT')).toBe('live');
    expect(statusOf('PST')).toBe('postponed');
    expect(statusOf('CANC')).toBe('cancelled');
    expect(statusOf(null)).toBe('scheduled');
  });
  it('normalizes an event, reading the timestamp as UTC', () => {
    const g = normalize(
      {
        idEvent: '1', idLeague: '4387', strLeague: 'NBA', strTimestamp: '2026-11-22T00:30:00', dateEvent: '2026-11-22', strTime: '00:30:00',
        strStatus: 'FT', idHomeTeam: 'h', idAwayTeam: 'a', strHomeTeam: 'New York Knicks', strAwayTeam: 'Portland Trail Blazers',
        intHomeScore: '97', intAwayScore: '96',
      },
      'NBA',
      'NBA',
    );
    expect(g.startsAt).toBe(Date.UTC(2026, 10, 22, 0, 30));
    expect([g.status, g.home.score, g.away.score]).toEqual(['final', 97, 96]);
  });
});
