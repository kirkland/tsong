import type {
  ServerMsg,
  WalletMsg,
  StockMsg,
  NetWorthMsg,
  LeaderboardMsg,
  LoanMsg,
  HouseMsg,
  NewsMsg,
  MarketMsg,
  LoanBookMsg,
  BalanceSheetMsg,
  NetizenInfoMsg,
  AnnounceMsg,
} from '../../shared/types.js';

export interface Cache {
  wallet: WalletMsg | null;
  stocks: StockMsg | null;
  netWorth: NetWorthMsg | null;
  leaderboard: LeaderboardMsg | null;
  loan: LoanMsg | null;
  house: HouseMsg | null;
  news: NewsMsg | null;
  market: MarketMsg | null;
  loanBook: LoanBookMsg | null;
  lastAnnounce: { text: string; at: number } | null;
  lastBalanceSheet: BalanceSheetMsg | null;
  lastNetizenInfo: NetizenInfoMsg | null;
}

export function freshCache(): Cache {
  return {
    wallet: null,
    stocks: null,
    netWorth: null,
    leaderboard: null,
    loan: null,
    house: null,
    news: null,
    market: null,
    loanBook: null,
    lastAnnounce: null,
    lastBalanceSheet: null,
    lastNetizenInfo: null,
  };
}

export function reduce(cache: Cache, msg: ServerMsg): Cache {
  switch (msg.type) {
    case 'wallet':
      return { ...cache, wallet: msg as WalletMsg };
    case 'stocks':
      return { ...cache, stocks: msg as StockMsg };
    case 'netWorth':
      return { ...cache, netWorth: msg as NetWorthMsg };
    case 'leaderboard':
      return { ...cache, leaderboard: msg as LeaderboardMsg };
    case 'loan':
      return { ...cache, loan: msg as LoanMsg };
    case 'house':
      return { ...cache, house: msg as HouseMsg };
    case 'news':
      return { ...cache, news: msg as NewsMsg };
    case 'market':
      return { ...cache, market: msg as MarketMsg };
    case 'loanBook':
      return { ...cache, loanBook: msg as LoanBookMsg };
    case 'balanceSheet':
      return { ...cache, lastBalanceSheet: msg as BalanceSheetMsg };
    case 'netizenInfo':
      return { ...cache, lastNetizenInfo: msg as NetizenInfoMsg };
    case 'announce': {
      const a = msg as AnnounceMsg;
      return { ...cache, lastAnnounce: { text: a.text, at: Date.now() } };
    }
    default:
      return cache;
  }
}
