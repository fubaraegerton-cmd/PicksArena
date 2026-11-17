import type { SportId, Team } from '../types';

export interface SportConfig {
  id: SportId;
  label: string;
  icon: string;
  positions: string[];
  /** stat types by position group (keys must match position) */
  stats: Record<string, { stat: string; mean: number; spread: number }[]>;
  teams: Team[];
}

const t = (abbr: string, name: string, color: string): Team => ({ abbr, name, color });

export const SPORTS: SportConfig[] = [
  {
    id: 'NBA',
    label: 'NBA',
    icon: '🏀',
    positions: ['PG', 'SG', 'SF', 'PF', 'C'],
    stats: {
      PG: [
        { stat: 'Points', mean: 22, spread: 8 },
        { stat: 'Assists', mean: 7.5, spread: 3 },
        { stat: 'Pts+Rebs+Asts', mean: 34, spread: 10 },
        { stat: '3-PT Made', mean: 2.5, spread: 1.5 },
      ],
      SG: [
        { stat: 'Points', mean: 19, spread: 7 },
        { stat: '3-PT Made', mean: 2.5, spread: 1.5 },
        { stat: 'Rebounds', mean: 4.5, spread: 2 },
      ],
      SF: [
        { stat: 'Points', mean: 18, spread: 7 },
        { stat: 'Rebounds', mean: 6, spread: 2 },
        { stat: 'Pts+Rebs+Asts', mean: 29, spread: 9 },
      ],
      PF: [
        { stat: 'Points', mean: 17, spread: 6 },
        { stat: 'Rebounds', mean: 8.5, spread: 3 },
        { stat: 'Blks+Stls', mean: 2.5, spread: 1 },
      ],
      C: [
        { stat: 'Rebounds', mean: 10.5, spread: 3 },
        { stat: 'Points', mean: 15, spread: 6 },
        { stat: 'Blks+Stls', mean: 2.5, spread: 1 },
      ],
    },
    teams: [
      t('HAR', 'Harbor City Waves', '#1f7ae0'),
      t('DSR', 'Desert Rattlers', '#e0761f'),
      t('NTH', 'Northern Lights', '#33c27a'),
      t('MET', 'Metro Titans', '#9b59ff'),
      t('BAY', 'Bayside Pelicans', '#14b8c4'),
      t('SUM', 'Summit Peaks', '#e04343'),
      t('CAP', 'Capital Monarchs', '#d4af37'),
      t('IRN', 'Iron Valley Forge', '#8a8f9c'),
    ],
  },
  {
    id: 'NFL',
    label: 'NFL',
    icon: '🏈',
    positions: ['QB', 'RB', 'WR', 'TE'],
    stats: {
      QB: [
        { stat: 'Pass Yards', mean: 245, spread: 45 },
        { stat: 'Pass TDs', mean: 1.5, spread: 1 },
        { stat: 'Rush Yards', mean: 18, spread: 12 },
        { stat: 'Completions', mean: 22, spread: 4 },
      ],
      RB: [
        { stat: 'Rush Yards', mean: 68, spread: 22 },
        { stat: 'Rush+Rec Yards', mean: 88, spread: 25 },
        { stat: 'Receptions', mean: 3, spread: 1.5 },
      ],
      WR: [
        { stat: 'Receiving Yards', mean: 62, spread: 22 },
        { stat: 'Receptions', mean: 5, spread: 2 },
        { stat: 'Longest Reception', mean: 22, spread: 7 },
      ],
      TE: [
        { stat: 'Receiving Yards', mean: 42, spread: 15 },
        { stat: 'Receptions', mean: 4, spread: 1.5 },
      ],
    },
    teams: [
      t('STL', 'Steel Harbor Ironmen', '#5b6573'),
      t('RDG', 'Ridgeback Rangers', '#c0392b'),
      t('CST', 'Coastline Mariners', '#2980b9'),
      t('PRA', 'Prairie Stallions', '#b9770e'),
      t('FRN', 'Frontier Outlaws', '#7d3c98'),
      t('GLC', 'Glacier Wolves', '#5dade2'),
      t('BLZ', 'Blaze City Firebirds', '#e67e22'),
      t('KNG', 'Kingsport Lions', '#27ae60'),
    ],
  },
  {
    id: 'MLB',
    label: 'MLB',
    icon: '⚾',
    positions: ['SP', 'OF', 'IF'],
    stats: {
      SP: [
        { stat: 'Strikeouts', mean: 6, spread: 2 },
        { stat: 'Outs Recorded', mean: 17, spread: 3 },
        { stat: 'Hits Allowed', mean: 5, spread: 1.5 },
      ],
      OF: [
        { stat: 'Total Bases', mean: 1.5, spread: 0.7 },
        { stat: 'Hits+Runs+RBIs', mean: 2, spread: 1 },
      ],
      IF: [
        { stat: 'Total Bases', mean: 1.5, spread: 0.7 },
        { stat: 'Hits+Runs+RBIs', mean: 2, spread: 1 },
      ],
    },
    teams: [
      t('MSN', 'Mission Bay Gulls', '#f39c12'),
      t('RVR', 'River City Barons', '#1a5276'),
      t('ORC', 'Orchard Hill Pickers', '#c0392b'),
      t('CNY', 'Canyon Diamondbacks', '#16a085'),
      t('ELM', 'Elmwood Owls', '#6c3483'),
      t('PRT', 'Port Royal Captains', '#2e4053'),
    ],
  },
  {
    id: 'NHL',
    label: 'NHL',
    icon: '🏒',
    positions: ['C', 'W', 'D', 'G'],
    stats: {
      C: [
        { stat: 'Shots On Goal', mean: 3, spread: 1 },
        { stat: 'Points', mean: 0.5, spread: 0.3 },
      ],
      W: [
        { stat: 'Shots On Goal', mean: 3, spread: 1 },
        { stat: 'Points', mean: 0.5, spread: 0.3 },
      ],
      D: [
        { stat: 'Blocked Shots', mean: 2, spread: 0.8 },
        { stat: 'Shots On Goal', mean: 2, spread: 0.8 },
      ],
      G: [{ stat: 'Goalie Saves', mean: 27, spread: 4 }],
    },
    teams: [
      t('FRS', 'Frost Bay Yetis', '#5dade2'),
      t('TMB', 'Timberline Lumberjacks', '#784212'),
      t('NVA', 'Nova Comets', '#8e44ad'),
      t('HRB', 'Harbor Sharks', '#117a65'),
      t('GRN', 'Granite Bears', '#7f8c8d'),
      t('AUR', 'Aurora Foxes', '#e74c3c'),
    ],
  },
  {
    id: 'SOCCER',
    label: 'Soccer',
    icon: '⚽',
    positions: ['FW', 'MF', 'DF', 'GK'],
    stats: {
      FW: [
        { stat: 'Shots', mean: 3, spread: 1 },
        { stat: 'Shots On Target', mean: 1.5, spread: 0.7 },
      ],
      MF: [
        { stat: 'Passes Attempted', mean: 52, spread: 10 },
        { stat: 'Shots', mean: 1.5, spread: 0.8 },
      ],
      DF: [
        { stat: 'Clearances', mean: 4, spread: 1.5 },
        { stat: 'Tackles', mean: 2, spread: 0.8 },
      ],
      GK: [{ stat: 'Goalie Saves', mean: 3, spread: 1 }],
    },
    teams: [
      t('ATH', 'Athletic Riverside', '#c0392b'),
      t('UNI', 'United Northgate', '#2471a3'),
      t('RYL', 'Royal Eastfield', '#f1c40f'),
      t('CTY', 'City Westbrook', '#5dade2'),
      t('SPT', 'Sporting Lakeview', '#27ae60'),
      t('OLY', 'Olympic Southport', '#7d3c98'),
    ],
  },
  {
    id: 'CFB',
    label: 'CFB',
    icon: '🎓',
    positions: ['QB', 'RB', 'WR'],
    stats: {
      QB: [
        { stat: 'Pass Yards', mean: 255, spread: 50 },
        { stat: 'Pass+Rush Yards', mean: 290, spread: 55 },
      ],
      RB: [
        { stat: 'Rush Yards', mean: 82, spread: 25 },
        { stat: 'Rush Attempts', mean: 17, spread: 4 },
      ],
      WR: [
        { stat: 'Receiving Yards', mean: 70, spread: 22 },
        { stat: 'Receptions', mean: 5, spread: 2 },
      ],
    },
    teams: [
      t('OAK', 'Oakridge State', '#a04000'),
      t('PIN', 'Pinecrest Tech', '#1e8449'),
      t('VAL', 'Valley A&M', '#922b21'),
      t('LKS', 'Lakeshore U', '#1f618d'),
      t('MTN', 'Mountain College', '#5b2c6f'),
      t('BAY', 'Bayfront State', '#d68910'),
    ],
  },
];

export const sportById = (id: SportId) => SPORTS.find((s) => s.id === id)!;
