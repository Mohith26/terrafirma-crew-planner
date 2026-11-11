# Crew Planner for TerraFirma Mission Control (concept)

**Live demo:** https://mohith26.github.io/terrafirma-crew-planner/

Unofficial concept demo by Mohith Gajjela. Not affiliated with TerraFirma. Synthetic data.

## What it is

TerraFirma runs retrofitted excavators, dozers, loaders and rollers from Mission Control, with one operator supervising several machines and stepping in when a machine needs help. The number of machines one operator can carry is the core economics of that model, and it is set by *interventions*: how often machines stop, why, how long each takes to clear, and whether stops arrive together.

Crew Planner is a Mission Control screen that, for tomorrow's shift plan:

1. **Forecasts interventions** from past shifts with a model that respects how stops actually arrive: person-detection stops hit several nearby machines at once, and obstacle / grade / manual stops come in bursts (one hard patch of ground causes more stops in the next minutes).
2. **Sizes the remote crew for each two-hour block**: the smallest crew with at least a 90% chance of keeping machine waiting under 5% of machine time *and* answering safety stops within 60 s (p95).
3. **Ranks what to automate next**: for each stop type, if it happened half as often, how likely is a crew with one fewer operator to still meet the service level?

## How it works (`core/crew.js`)

- **Intervention model.** Person stops: site-level inhomogeneous Poisson by hour, each event stopping 1 to 3 active machines (empirical spill distribution). Obstacle, grade-check and manual-segment stops: self-exciting Hawkes processes with an exponential kernel per (stop type, task), fitted by EM (background rate, branching ratio, decay). Truck spotting and workflow handoffs: Poisson per task. Handling times: lognormal per stop type (MLE).
- **Uncertainty.** Each simulated shift draws its rates from a Gamma posterior given the fitted counts, then simulates tomorrow's plan.
- **Queue.** A discrete-event, non-preemptive priority queue (safety stops first, then manual/obstacle, grade/truck, handoffs) with the crew size changing by block. Metrics are attributed to the block where the stop arrived.
- **Staffing.** Blocks are solved in time order (a forward-in-time queue means later blocks never change earlier ones): the smallest crew whose share of 300 simulated shifts meeting the service level is at least 90%.
- **Baselines.** A flat 1 operator per 3 machines, and Erlang-C (textbook M/M/c staffing at the fitted mean rate, which assumes stops arrive independently).
- **Automation ranking.** Common random numbers: the same 300 simulated shifts, thinned by 50% for one stop type, replayed with one fewer operator.

Everything on the page is computed in the browser from `data/history.js` (40 training shifts, 20 held-out shifts, tomorrow's plan), produced by `scripts/generate.js` with a fixed seed.

## Results on the synthetic history

Held-out backtest (20 shifts, 100 two-hour blocks), `node scripts/frontier.js`:

| Policy | Blocks meeting the service level | Operator-hours per shift |
|---|---|---|
| Crew Planner (90% target) | 95% | 30.1 |
| Crew Planner (80% target) | 89% | 26.9 |
| Flat 1:2 | 96% | 33.5 |
| Flat 1:2.5 | 86% | 28.0 |
| Flat 1:3 | 81% | 23.5 |
| Erlang-C | 40% | 13.3 |

- The planner is calibrated: asked for 90% per block, it delivered 95% on shifts it never saw.
- Textbook queueing badly understaffs because stops are bursty and person stops hit several machines at once (it met the target in 40% of blocks).
- Against flat ratios the gain is modest and honest: for the same reliability it needs roughly 10% fewer operator-hours (30.1 h vs 33.5 h at about 95%). The bigger value is knowing, per shift, when a ratio is wrong.
- For tomorrow's plan the ranking says halving **person-detection stops** raises the chance that one fewer operator still meets the target from 71% to 87%, while halving **truck spotting**, the most frequent stop (98 per shift), barely moves it (72%). Manual segments use the most operator time but rank second.

## Tests

`node --test test/crew.test.js` (8 tests): Erlang-C formula; Hawkes simulation mean and EM recovery of (mu, alpha, beta); the queue simulator against the Erlang-C closed form for M/M/c; priority order; peak-concurrency sweep; fit recovers the generator's rates, burstiness, handling times and spill; the planner's chance curve is monotone and meets its target; and the backtest numbers on the page.

## Honest limitations

- **Synthetic data.** The generator's rates, burstiness and handling times are assumptions chosen to look like a mixed earthwork site; nothing here is TerraFirma data. With real Mission Control logs (stop reason, start, takeover, resume), the same fit and planner run unchanged.
- The queue is non-preemptive and one operator handles one stop at a time; real operators may batch quick acknowledgements or preempt a manual segment for a safety stop.
- A stopped machine does not generate further stops in the model, and stops do not change the work plan.
- The safety criterion (p95 within a two-hour block) rests on few events per block, so it is close to "the worst safety response in the block".
- The Mission Control screen is rebuilt from frames of TerraFirma's public Mission Control video; the top-bar tabs other than the real panel names (Surfaces, Objectives) are my guesses.

## Novelty note

Searched terrafirma.inc (Mission Planner, Mission Control, Accelerated Operations), the Series A coverage (BusinessWire, Kleiner Perkins, CNBC, Robot Report, Equipment World) and all 35 TerraFirma job posts (including Mission Control Software Engineer) for crew sizing, operator-to-machine staffing, intervention forecasting or automation ROI; none is announced. Adjacent: InOrbit and Moravec offer fleet ops consoles and managed remote-operator rostering, and research (Fleet-DAgger, operator-assistance scheduling) studies allocating human attention across robot fleets; none forecasts bursty, multi-machine interventions from a construction shift plan to size a crew with a calibrated service level or ranks autonomy work by the operator it frees.

## Run

```
node scripts/generate.js     # regenerate data/history.js
node --test test/crew.test.js
node scripts/frontier.js     # backtest table above
python3 -m http.server       # or open index.html
```
