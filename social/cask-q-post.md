# CASK-Q launch post

Image: `assets/cask-q-announcement.png` (1200×675, rendered from `social/cask-q-announcement.html`)
Link: https://decentralizedcompute.company/cask-q.html

## Main post (X)

We just published CASK-Q, a new quantization algorithm from TDCC.

Low-bit quantization doesn't only break weights. It breaks the query × key interaction that attention runs on. CASK-Q calibrates Q and K together, so that interaction survives.

Results:
→ −25.2% attention-output error at 2-bit
→ −28.1% at 3-bit
→ 60/60 paired seed wins
→ same bytes on disk
→ 12.6× faster calibration loss than dense at long context

Paper 👇
decentralizedcompute.company/cask-q

Open-source code 👇
github.com/the-decentralized-compute-company/quantization

We don't just talk. We compute. $COMPUTE

## Thread

2/ Most quantizers reconstruct Q and K separately. Attention depends on their product, so a small error in one can blow up in the other. A small error in Q can also be cancelled by K. CASK-Q optimizes for what softmax actually sees: the row-centered causal logit error.

3/ The trick: shared random sign probes plus an exact prefix-sum identity. You get an unbiased estimate of the full N×N error in O(Ndr) without ever building the N×N matrix. Proven mean and variance, plus a sharp KL bound.

4/ The export is still plain scalar codes plus FP16 scales. No new kernel, no extra bytes. Only the calibration changes.

5/ What the paper claims, stated plainly: these results are from controlled synthetic attention experiments, measured against independent Q/K reconstruction on the same quantizer. The next step is full pretrained LLMs. Everything is in the PDF, including the limitations. Code, scripts and results are open source: github.com/the-decentralized-compute-company/quantization

6/ CASK-Q is the research layer under the TDCC network. The goal is lower-bit models with less error, so everyday PCs and GPUs can run bigger models and do useful compute. $COMPUTE

Official CA only from @computecompany. We never DM first.

## Short version (Telegram / Discord)

🧪 NEW PAPER: CASK-Q
TDCC's new joint query–key quantization algorithm.
−25.2% attention error at 2-bit, −28.1% at 3-bit, same file size, 60/60 seeds.
📄 decentralizedcompute.company/cask-q
💻 github.com/the-decentralized-compute-company/quantization
$COMPUTE. We don't just talk. We compute.
