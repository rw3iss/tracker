type TabMessage =
  | { type: 'query' }
  | { type: 'victory';   tabId: string }
  | { type: 'heartbeat'; tabId: string }
  | { type: 'resign';    tabId: string };

const CHANNEL_NAME     = '__vt_coordinator__';
const ELECTION_WAIT_MS = 80;
const HEARTBEAT_MS     = 1_000;
const LEADER_TIMEOUT_MS = 2_500;

export interface TabCoordinatorOptions {
  onLeaderChange?: (isLeader: boolean) => void;
}

export class TabCoordinator {
  private readonly channel: BroadcastChannel;
  readonly tabId: string;
  private _isLeader = false;
  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaderTimeout: ReturnType<typeof setTimeout> | null = null;
  private receivedVictory = false;
  private readonly onLeaderChange?: (isLeader: boolean) => void;

  constructor(opts: TabCoordinatorOptions = {}) {
    this.tabId          = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.onLeaderChange = opts.onLeaderChange;
    this.channel        = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (e) => this.handleMessage(e.data as TabMessage);
    this.startElection();
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  private startElection(): void {
    this.receivedVictory = false;
    if (this.leaderTimeout) { clearTimeout(this.leaderTimeout); this.leaderTimeout = null; }
    this.channel.postMessage({ type: 'query' } satisfies TabMessage);
    this.electionTimer = setTimeout(() => {
      this.electionTimer = null;
      if (!this.receivedVictory && !this._isLeader) {
        this.claimLeadership();
      }
    }, ELECTION_WAIT_MS);
  }

  private claimLeadership(): void {
    this._isLeader = true;
    this.channel.postMessage({ type: 'victory', tabId: this.tabId } satisfies TabMessage);
    this.onLeaderChange?.(true);
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this.channel.postMessage({ type: 'heartbeat', tabId: this.tabId } satisfies TabMessage);
      }, HEARTBEAT_MS);
    }
  }

  private yieldLeadership(): void {
    this._isLeader = false;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.onLeaderChange?.(false);
    this.resetLeaderTimeout();
  }

  private resetLeaderTimeout(): void {
    if (this.leaderTimeout) clearTimeout(this.leaderTimeout);
    this.leaderTimeout = setTimeout(() => {
      this.leaderTimeout = null;
      // Leader gone — re-elect
      this.startElection();
    }, LEADER_TIMEOUT_MS);
  }

  private handleMessage(msg: TabMessage): void {
    switch (msg.type) {
      case 'query':
        if (this._isLeader) {
          this.channel.postMessage({ type: 'victory', tabId: this.tabId } satisfies TabMessage);
        }
        break;

      case 'victory':
        if (msg.tabId === this.tabId) break;
        this.receivedVictory = true;

        if (this._isLeader) {
          // Two leaders: lower tabId wins
          if (msg.tabId < this.tabId) {
            this.yieldLeadership();
          }
          // else: the other tab will yield when it receives our victory
        } else {
          // There is a live leader — reset the dead-leader timeout
          this.resetLeaderTimeout();
        }
        break;

      case 'heartbeat':
        if (!this._isLeader) {
          this.resetLeaderTimeout();
        }
        break;

      case 'resign':
        if (!this._isLeader) {
          // Cancel existing leader timeout and re-elect immediately
          if (this.leaderTimeout) { clearTimeout(this.leaderTimeout); this.leaderTimeout = null; }
          this.startElection();
        }
        break;
    }
  }

  destroy(): void {
    if (this.electionTimer)  { clearTimeout(this.electionTimer);   this.electionTimer  = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.leaderTimeout)  { clearTimeout(this.leaderTimeout);   this.leaderTimeout  = null; }
    const wasLeader  = this._isLeader;
    // Clear leadership BEFORE posting resign so that if re-election queries arrive
    // synchronously (via BroadcastChannel) we don't mistakenly respond with victory.
    this._isLeader = false;
    if (wasLeader) {
      this.channel.postMessage({ type: 'resign', tabId: this.tabId } satisfies TabMessage);
    }
    this.channel.close();
  }
}
