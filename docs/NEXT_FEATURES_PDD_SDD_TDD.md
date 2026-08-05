# Next Diagnostic Features: PDD/SDD/TDD Framework

> **Status (2026-08-05): Features 1-5 below are implemented.** This was the
> original planning doc for canonical hypotheses #1-5 (latency/jitter,
> packet loss, MTU/PMTUD, TCP state, dual-stack); Features 1-4 map to
> `diagnostic_engine.classify_latency`/`classify_latency_under_load`,
> `classify_packet_loss`/`detect_asymmetric_loss`, `find_path_mtu`/
> `diagnose_pmtud`, and `build_state_machine` respectively (see `API.md`),
> and Feature 5 to `analyze_dual_stack` and its siblings. They were actually
> built once already (Phases 1-5 in git history) but lost to a phase-
> overwrite bug and restored from this spec — see `OPEN-ISSUES.md` #12 for
> the full story. The gaps listed below that this doc's five features don't
> cover (DNSSEC validation, TLS/HTTP protocol negotiation, stateful firewall
> patterns) remain open; nothing in this repo implements them yet. Left
> below verbatim as the original spec/planning record, not because it's
> still a to-do list for Features 1-5.

## Current State Assessment

**What You Have:**
- ✓ Binary test results (OK/FAIL/TIMEOUT/UNAVAILABLE)
- ✓ 5 network layers (Gateway → ISP → DNS → TLS → Connection Hold)
- ✓ Burst pattern detection
- ✓ Historical confidence tracking
- ✓ Hypothesis ranking

**Precision Gaps:**
- No latency/jitter analysis (only pass/fail)
- No packet loss pattern types (burst vs steady degradation)
- No MTU/MSS discovery (fragmentation not detected)
- No connection state tracking (SYN/ACK patterns)
- No asymmetric routing detection
- No dual-stack (IPv4/IPv6) isolation
- No DNSSEC validation
- No protocol negotiation issues (TLS version, HTTP version)
- No stateful firewall pattern detection

---

## Feature 1: Latency & Jitter Classifier

### Precision Goal
**"I know if I have a latency problem, what KIND of latency problem it is."**

### PDD - Properties That Must Hold

```python
# Property 1: Latency Measurement Consistency
assert latency_measurements[i].timestamp < latency_measurements[i+1].timestamp
# All measurements are time-ordered

# Property 2: Jitter is Non-Negative
assert jitter >= 0
# Jitter = max_latency - min_latency. Never negative.

# Property 3: Latency Categories are Exhaustive & Disjoint
latency_categories = {
    "stable_low": (latency < 50ms AND jitter < 10ms),
    "stable_medium": (latency 50-100ms AND jitter < 20ms),
    "variable": (jitter > latency * 0.3),  # High variance relative to mean
    "high_variance_high_latency": (latency > 100ms AND jitter > 30ms),
}
# Every measurement falls into exactly one category

# Property 4: Buffer Bloat Detector
# If (mean_latency_under_load - mean_latency_idle) > 100ms
# THEN we have buffer bloat (measurable buffering issue)
assert latency_differential >= 0  # Load increases latency or stays same
```

### SDD - Exact Behaviors Specified

**Scenario: Stable Low Latency**
```gherkin
Given ping to gateway succeeds
When latency < 50ms for 10 consecutive pings
  AND jitter < 10ms
Then classify as "stable_low"
  AND confidence = 100%
  AND culprit_hypothesis = "no latency issue"
```

**Scenario: High Variable Latency**
```gherkin
Given ping to gateway succeeds
When median_latency = 50ms
  AND jitter = 45ms (high variance)
Then classify as "variable"
  AND confidence = 80%
  AND culprit_hypothesis_rank = [
    "buffer_bloat",
    "wifi_interference", 
    "network_congestion",
    "gateway_queueing"
  ]
```

**Scenario: Buffer Bloat Detection**
```gherkin
Given idle latency = 15ms, latency under load = 120ms
When latency_differential = 105ms
Then classify as "buffer_bloat"
  AND suggest_fix = "enable_sqm_qdisc"
  AND confidence = 85%
```

### TDD - Tests That Verify It Works

```python
def test_latency_classifier_stable_low():
    """Stable low latency: < 50ms with < 10ms jitter."""
    pings = [
        {"latency_ms": 12, "timestamp": 0},
        {"latency_ms": 15, "timestamp": 1},
        {"latency_ms": 14, "timestamp": 2},
        # ... 7 more pings in 10-15ms range
    ]
    result = classify_latency(pings)
    assert result["category"] == "stable_low"
    assert result["jitter"] < 10
    assert result["culprit"] == "none"

def test_latency_classifier_buffer_bloat():
    """Buffer bloat: idle=15ms, loaded=120ms, delta=105ms."""
    idle_pings = [{"latency_ms": 15} for _ in range(10)]
    loaded_pings = [{"latency_ms": 120} for _ in range(10)]
    result = classify_latency_under_load(idle_pings, loaded_pings)
    assert result["category"] == "buffer_bloat"
    assert result["differential_ms"] == 105
    assert "sqm" in result["suggested_fixes"]

def test_latency_classifier_high_variance():
    """High variance: median 50ms, jitter 45ms."""
    pings = [
        {"latency_ms": 8},
        {"latency_ms": 95},
        {"latency_ms": 12},
        {"latency_ms": 88},
        {"latency_ms": 15},
    ]
    result = classify_latency(pings)
    assert result["category"] == "variable"
    assert result["jitter"] > result["median"] * 0.3
    assert any(h in result["hypotheses"] for h in 
               ["buffer_bloat", "wifi_interference"])
```

---

## Feature 2: Packet Loss Pattern Classifier

### Precision Goal
**"I know if I have packet loss, what pattern it follows."**

### PDD - Properties

```python
# Property 1: Loss Rate is Ratio
assert 0 <= loss_rate <= 1
assert loss_rate == lost_packets / total_packets

# Property 2: Burst Loss Pattern Detection
# If consecutive losses cluster, it's burst loss (not random)
burst_detected = any(
    consecutive_failures >= 3
    for consecutive_failures in loss_burst_lengths
)
# Burst loss suggests gateway/modem issue, not congestion

# Property 3: Steady Degradation Pattern
# If loss is distributed evenly across time window, it's steady
random_detected = all(
    loss_gap_variance > expected_random_variance * 0.8
    for loss_gap in loss_timing_gaps
)
# Even loss suggests link saturation or QoS rate limiting

# Property 4: Loss Bidirectional Detection
# If outbound loss != inbound loss, path is asymmetric
asymmetric = abs(outbound_loss - inbound_loss) > 5%
```

### SDD - Exact Behaviors

**Scenario: Burst Packet Loss**
```gherkin
Given 100 ping attempts to gateway
When 5 consecutive pings fail (others succeed)
  AND total loss < 10%
Then classify as "burst_loss"
  AND confidence = 90%
  AND culprit_hypothesis_rank = [
    "gateway_timeout",
    "modem_retransmit",
    "wifi_channel_congestion"
  ]
```

**Scenario: Steady Packet Loss**
```gherkin
Given 100 ping attempts over 100 seconds
When loss_rate = 5%
  AND losses distributed evenly (±2 pings per 10-second window)
Then classify as "steady_degradation"
  AND confidence = 85%
  AND culprit_hypothesis_rank = [
    "link_saturation",
    "qos_rate_limiting",
    "distance_from_ap"
  ]
```

### TDD - Tests

```python
def test_packet_loss_burst_detection():
    """Burst: 5 consecutive failures in 100 pings."""
    results = ["ok"] * 25 + ["fail"] * 5 + ["ok"] * 70
    classification = classify_packet_loss(results)
    assert classification["pattern"] == "burst_loss"
    assert classification["burst_length"] >= 5
    assert "gateway_timeout" in classification["hypotheses"]

def test_packet_loss_steady_degradation():
    """Steady loss: ~5% loss evenly distributed."""
    # 95 ok, 5 fail, spread across time
    results = generate_random_loss(total=100, loss_pct=5)
    assert check_distribution_uniform(results)
    classification = classify_packet_loss(results)
    assert classification["pattern"] == "steady_degradation"
    assert "link_saturation" in classification["hypotheses"]

def test_packet_loss_asymmetric_path():
    """Asymmetric: outbound 2%, inbound 8%."""
    outbound_loss = 0.02
    inbound_loss = 0.08
    result = detect_asymmetric_loss(outbound_loss, inbound_loss)
    assert result["asymmetric"] == True
    assert result["differential_pct"] == 6.0
    assert "asymmetric_routing" in result["hypotheses"]
```

---

## Feature 3: MTU/MSS Discovery & Fragmentation

### Precision Goal
**"I know if packets are fragmenting and what the path MTU is."**

### PDD - Properties

```python
# Property 1: Path MTU is Path Maximum
# Largest packet that reaches destination unfragmented
assert path_mtu == max(successful_packet_sizes)

# Property 2: Standard MTU Values
# Ethernet=1500, WiFi=1500, PPPoE=1492, cellular=1440
assert path_mtu in {1500, 1492, 1440, 1280, 1472}

# Property 3: Fragmentation Causes Latency Increase
# If multiple fragments needed: latency_fragmented > latency_unfragmented
assert latency_fragmented >= latency_unfragmented

# Property 4: PMTUD Works or is Broken
# If DF-bit set and no ICMP fragmentation needed:
#   - Success: packet reaches, PMTUD working
#   - Failure: packet lost, PMTUD broken (ICMP blocked)
assert pmtud_working or icmp_blocked
```

### SDD - Exact Behaviors

**Scenario: Path MTU Discovery Succeeds**
```gherkin
Given tracepath to api.openai.com
When test packets 1500, 1472, 1440, 1280 bytes
Then find_largest_successful = 1472
  AND pmtud_status = "working"
  AND confidence = 95%
  AND culprit = "none"
```

**Scenario: PMTUD is Broken**
```gherkin
Given DF-bit packet 1500 bytes to destination
When ICMP fragmentation-needed NOT received
  AND packet lost
  AND no fallback to smaller MTU
Then pmtud_status = "broken"
  AND confidence = 90%
  AND culprit_hypothesis_rank = [
    "firewall_blocks_icmp",
    "isp_filters_icmp",
    "carrier_pmtud_disabled"
  ]
```

### TDD - Tests

```python
def test_path_mtu_discovery_basic():
    """Find path MTU by binary search."""
    mtus_to_test = [1500, 1400, 1300, 1200]
    results = {1500: False, 1400: True, 1300: True, 1200: True}
    path_mtu = find_path_mtu(results)
    assert path_mtu == 1400

def test_pmtud_broken_icmp_blocked():
    """PMTUD broken: DF-bit packet lost, no ICMP fragmentation needed."""
    packet_1500_df_result = "lost"
    icmp_fragmentation_needed_received = False
    result = diagnose_pmtud(packet_1500_df_result, 
                           icmp_fragmentation_needed_received)
    assert result["pmtud_status"] == "broken"
    assert "firewall_blocks_icmp" in result["hypotheses"]

def test_fragmentation_latency_overhead():
    """Fragmented packet has measurable latency increase."""
    unfragmented_latency = 25  # 1400 byte packet
    fragmented_latency = 35    # 1500 byte packet fragmented
    overhead = fragmented_latency - unfragmented_latency
    assert overhead >= 8  # At least 8ms overhead
```

---

## Feature 4: Connection State Machine Tracking

### Precision Goal
**"I know if the TCP handshake is working, or if RST/timeouts happen."**

### PDD - Properties

```python
# Property 1: TCP States are Ordered
# SYN -> SYN-ACK -> ACK -> [DATA] -> FIN -> FIN-ACK -> CLOSE
# No state can be skipped; all are monotonic in time

# Property 2: RTT is Handshake Duration
# RTT = time_ACK_received - time_SYN_sent
assert rtt_ms == (time_ack - time_syn)

# Property 3: RST Before Established is Rejection
# If RST received before ACK, connection rejected
assert rst_before_ack implies "connection_rejected"

# Property 4: Timeout Pattern is Detectable
# SYN with no response after 3s, 6s, 12s = classic TCP backoff
assert syn_timeouts in [3, 6, 12, 24, 48]  # Linux default backoff
```

### SDD - Exact Behaviors

**Scenario: Normal Connection Establishment**
```gherkin
Given connect to api.openai.com:443
When send SYN at T=0
  AND receive SYN-ACK at T=50ms
  AND send ACK at T=51ms
  AND connection established at T=52ms
Then state_machine = "established"
  AND handshake_rtt = 50ms
  AND culprit = "none"
```

**Scenario: Connection Reset**
```gherkin
Given connect to api.openai.com:443
When send SYN at T=0
  AND receive RST at T=10ms
Then state_machine = "rejected"
  AND confidence = 100%
  AND culprit_hypothesis_rank = [
    "port_closed",
    "firewall_blocked",
    "server_refused"
  ]
```

### TDD - Tests

```python
def test_tcp_handshake_normal():
    """Normal handshake: SYN -> SYN-ACK -> ACK."""
    events = [
        {"time": 0, "type": "SYN_sent", "port": 443},
        {"time": 50, "type": "SYN_ACK_received"},
        {"time": 51, "type": "ACK_sent"},
    ]
    state_machine = build_state_machine(events)
    assert state_machine["state"] == "established"
    assert state_machine["handshake_rtt"] == 50

def test_tcp_connection_rejected():
    """RST before ACK means connection rejected."""
    events = [
        {"time": 0, "type": "SYN_sent"},
        {"time": 10, "type": "RST_received"},
    ]
    state_machine = build_state_machine(events)
    assert state_machine["state"] == "rejected"
    assert state_machine["reason"] == "RST_before_ACK"

def test_tcp_syn_timeout_backoff():
    """SYN timeout follows Linux backoff: 3s, 6s, 12s."""
    events = [
        {"time": 0, "type": "SYN_sent"},
        {"time": 3000, "type": "SYN_retransmit"},
        {"time": 9000, "type": "SYN_retransmit"},
        {"time": 21000, "type": "timeout"},
    ]
    state_machine = build_state_machine(events)
    assert state_machine["timeouts"] == [3000, 6000, 12000]
    assert state_machine["pattern"] == "syn_backoff"
```

---

## Feature 5: Dual-Stack (IPv4/IPv6) Isolation

### Precision Goal
**"I know if the issue is IPv4-only, IPv6-only, or both."**

### PDD - Properties

```python
# Property 1: Dual Stack is Independent
# IPv4 health and IPv6 health are measured independently
assert ipv4_result != ipv6_result or (
    ipv4_result == ipv6_result  # Both work or both fail
)

# Property 2: Dual Stack Preference Respected
# If IPv6 available, modern apps prefer it (RFC 3484)
# Falling back to IPv4 should be transparent
assert prefer_ipv6_on_success

# Property 3: Happy Eyeballs Timeout (RFC 8305)
# First attempt (preferred) waits 250ms before second (fallback)
assert second_attempt_delay == 250
```

### SDD - Exact Behaviors

**Scenario: IPv6 Broken, IPv4 Works**
```gherkin
Given resolve api.openai.com
When AAAA record exists but timeout after 3 retries
  AND A record resolves and connects normally
Then ipv6_status = "broken"
  AND ipv4_status = "working"
  AND fallback = "automatic_to_ipv4"
  AND culprit_hypothesis = [
    "ipv6_route_missing",
    "isp_blocks_ipv6",
    "router_ipv6_disabled"
  ]
```

### TDD - Tests

```python
def test_dual_stack_ipv6_broken_ipv4_works():
    """IPv6 timeout, IPv4 succeeds."""
    ipv6_result = {"status": "timeout", "attempts": 3}
    ipv4_result = {"status": "ok", "latency": 30}
    analysis = analyze_dual_stack(ipv6_result, ipv4_result)
    assert analysis["ipv6"] == "broken"
    assert analysis["ipv4"] == "working"
    assert "ipv6_route_missing" in analysis["hypotheses"]

def test_dual_stack_happy_eyeballs_timeout():
    """Happy Eyeballs: IPv6 timeout at 250ms, IPv4 starts."""
    events = [
        {"time": 0, "event": "IPv6_AAAA_sent"},
        {"time": 250, "event": "IPv4_A_sent", "reason": "timeout"},
        {"time": 280, "event": "A_resolved"},
    ]
    result = validate_happy_eyeballs(events)
    assert result["fallback_triggered"] == True
    assert result["fallback_time"] == 250
```

---

## Implementation Roadmap (Phase 2)

**Status, 2026-08-05:** checked off below where actually implemented (see
the banner at the top of this doc). Unchecked items are genuinely still
open — mostly "wire this into the live per-tick path," which every sibling
analysis function in `diagnostic_engine.py` (dual-stack, routing, TLS,
buffering) also doesn't do; these classifiers are consistent with that
existing pattern, not a gap unique to them.

### Sprint 1: Latency & Jitter (Week 1-2)
- [ ] Add latency metric collection to probe runner — `probes.ping` already
      gives round-trip latency per tick; no dedicated collection *pipeline*
      feeding `classify_latency` was added on top of that
- [x] Implement `classify_latency()` with categories (5, not 4 — added
      `stable_high` for the "high latency, low jitter" case the original 4
      didn't have a bucket for)
- [x] Add buffer bloat detection under load (`classify_latency_under_load`)
- [x] Create 5+ tests covering all scenarios (7, `LatencyJitterClassifierTest`)
- [ ] Integrate into diagnostic rules

### Sprint 2: Packet Loss Patterns (Week 2-3)
- [x] Implement burst detection algorithm (`classify_packet_loss`)
- [x] Implement random/steady loss detection (`steady_degradation`)
- [x] Add asymmetric path detection (`detect_asymmetric_loss`)
- [x] Create 5+ tests (6, `PacketLossPatternTest`)
- [ ] Update hypothesis ranking with loss patterns

### Sprint 3: MTU Discovery (Week 3-4)
- [~] MTU discovery — `environ.mtu()` walks a fixed descending list of
      standard sizes (a linear search over 6 known values), not a binary
      search; genuinely live against the real path via the DF bit
- [x] PMTUD status checking (`diagnose_pmtud`)
- [ ] Fragmentation latency measurement
- [x] Create 5+ tests (5, `MtuPmtudTest`)

### Sprint 4: TCP State Tracking (Week 4-5)
- [ ] Packet capture (tcpdump/Wireshark parsing) — out of scope; see
      `OPEN-ISSUES.md` #12. `build_state_machine` classifies a list of
      already-timestamped events; nothing produces those events from a
      real connection yet
- [x] State machine builder (`build_state_machine`)
- [x] RST/timeout pattern detection (rejected/reset states, `syn_backoff`)
- [x] Create 5+ tests (5, `TcpStateMachineTest`)

### Sprint 5: Dual-Stack Isolation (Week 5-6)
(Predates this restoration — built in the original Phase 5, unaffected by
the overwrite bug that hit Sprints 1-4.)
- [ ] Separate IPv4/IPv6 probes — `analyze_dual_stack` takes pre-gathered
      `ipv4_result`/`ipv6_result` dicts rather than probing both live itself
- [x] Happy Eyeballs RFC 8305 implementation (`detect_happy_eyeballs`)
- [x] Fallback detection (`analyze_dual_stack`'s `affected_stack`,
      `detect_dual_stack_preference`)
- [x] Create 5+ tests (`DualStackIsolationTest`)

---

## Testing Strategy

Each feature follows strict TDD:
1. **Write test first** with fixture data
2. **Test fails** (red)
3. **Implement feature** (green)
4. **Refactor with confidence** (refactor)
5. **Verify against real network data** (validation)

All tests are **deterministic** - use captured probe outputs, no live network.

---

## Success Criteria

After implementing all 5 features, the system should be able to say:

✓ "Your latency is stable at 25ms with 3ms jitter"
✓ "You have 2% burst packet loss (gateway issue) every 5 minutes"
✓ "Your path MTU is 1472 bytes; PMTUD is working"
✓ "TCP handshakes take 45ms; SYN timeouts every hour at 9 AM"
✓ "IPv6 is broken (unreachable); your ISP blocks it; falling back to IPv4"

Not just "your network is broken" - **exactly why and how it's broken**.
