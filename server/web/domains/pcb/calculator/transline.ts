// calculator/transline — KiCad's common/transline_calculations, the transmission line models the Tuning Profiles
// page of Board Setup calculates track widths, diff pair gaps and unit delays with (and the PCB calculator's
// transmission line panel is built on):
//   TRANSLINE_CALCULATION_BASE      transline_calculation_base.cpp (parameters, results, MinimiseZ0Error1D,
//                                   skin depth, unit propagation delay, the soldermask correction, elliptic integrals)
//   DIELECTRIC_DJORDJEVIC_SARKAR    dielectric_djordjevic_sarkar.cpp (wideband causal dielectric model)
//   MICROSTRIP                      microstrip.cpp
//   STRIPLINE                       stripline.cpp
//   COUPLED_MICROSTRIP              coupled_microstrip.cpp
//   COUPLED_STRIPLINE               coupled_stripline.cpp
// Pure numerics: every formula, iteration limit and status rule is the C++'s, in the same order.

/** TRANSLINE_PARAMETERS */
export enum TCP {
  UNKNOWN_ID = -1,
  EPSILONR, TAND, RHO, H, H_T, T, PHYS_WIDTH, PHYS_DIAM_IN, PHYS_S, PHYS_DIAM_OUT, PHYS_LEN, ROUGH, MUR, MURC, FREQUENCY,
  STRIPLINE_A, TWISTEDPAIR_TWIST, TWISTEDPAIR_EPSILONR_ENV, Z0, Z0_E, Z0_O, ANG_L, DUMMY_PRM,
  SIGMA, SKIN_DEPTH, LOSS_DIELECTRIC, LOSS_CONDUCTOR, CUTOFF_FREQUENCY, EPSILON_EFF, EPSILON_EFF_EVEN, EPSILON_EFF_ODD,
  UNIT_PROP_DELAY, UNIT_PROP_DELAY_ODD, UNIT_PROP_DELAY_EVEN, ATTEN_COND, ATTEN_COND_EVEN, ATTEN_COND_ODD,
  ATTEN_DILECTRIC, ATTEN_DILECTRIC_EVEN, ATTEN_DILECTRIC_ODD, Z_DIFF, Z_COMM, COUPLING_K, CPW_BACKMETAL,
  DIELECTRIC_MODEL_SEL, EPSILONR_SPEC_FREQ, SOLDERMASK_PRESENT, SOLDERMASK_THICKNESS, SOLDERMASK_EPSILONR,
  SOLDERMASK_TAND, SOLDERMASK_FILLS_GAPS, EXTRAS_COUNT,
}
/** SYNTHESIZE_OPTS */
export enum SYNTHESIZE_OPTS { DEFAULT, FIX_WIDTH, FIX_SPACING, FROM_ZDIFF_ZCOMM }
/** DIELECTRIC_MODEL */
export enum DIELECTRIC_MODEL { CONSTANT, DJORDJEVIC_SARKAR }
/** TRANSLINE_STATUS */
export enum TRANSLINE_STATUS { OK, WARNING, TS_ERROR }

/** transline_calculations/units.h */
export const MU0 = 12.566370614e-7;
export const E0 = 8.854e-12;
export const C0 = 299792458.0;
export const ZF0 = 376.730313412;
export const LOG2DB = 20.0 / Math.log(10.0);
/** units_scales.h UNIT_MIL */
const UNIT_MIL = 1e-5 * 2.54;

const PI = Math.PI, M_PI_2 = Math.PI / 2;
const isfinite = (x: number): boolean => Number.isFinite(x);

// ---------------------------------------------------------------- DIELECTRIC_DJORDJEVIC_SARKAR
/** std::log of the complex (a + j f) / (b + j f) */
function logRatio(a: number, b: number, f: number): [number, number] {
  const den = b * b + f * f, re = (a * b + f * f) / den, im = (f * b - a * f) / den;
  return [Math.log(Math.hypot(re, im)), Math.atan2(im, re)];
}
export class DIELECTRIC_DJORDJEVIC_SARKAR {
  private epsInf = 1.0; private m = 0.0; private f1 = 1.0e3; private f2 = 1.0e12; private lossless = true;
  /** Fit; throws (std::invalid_argument) for f1 <= 0, f2 <= f1 or f_spec outside [f1, f2]. */
  Fit(aEpsRSpec: number, aTanDSpec: number, aFSpec: number, aF1 = 1.0e3, aF2 = 1.0e12): void {
    if (aF1 <= 0.0) throw new RangeError("DIELECTRIC_DJORDJEVIC_SARKAR: f1 must be positive");
    if (aF2 <= aF1) throw new RangeError("DIELECTRIC_DJORDJEVIC_SARKAR: f2 must exceed f1");
    if (aFSpec < aF1 || aFSpec > aF2) throw new RangeError("DIELECTRIC_DJORDJEVIC_SARKAR: f_spec outside [f1, f2]");
    this.f1 = aF1; this.f2 = aF2;
    if (aTanDSpec === 0.0) { this.lossless = true; this.epsInf = aEpsRSpec; this.m = 0.0; return; }
    const [kRe, kIm] = logRatio(aF2, aF1, aFSpec);
    this.m = -aTanDSpec * aEpsRSpec / kIm;
    this.epsInf = aEpsRSpec * (1.0 + aTanDSpec * kRe / kIm);
    this.lossless = false;
  }
  /** Complex relative permittivity at aF as [re, im] */
  ComplexEpsilonAt(aF: number): [number, number] {
    if (this.lossless) return [this.epsInf, 0.0];
    const [lRe, lIm] = logRatio(this.f2, this.f1, aF);
    return [this.epsInf + this.m * lRe, this.m * lIm];
  }
  EpsilonRealAt(aF: number): number { return this.ComplexEpsilonAt(aF)[0]; }
  TanDeltaAt(aF: number): number { if (this.lossless) return 0.0; const [re, im] = this.ComplexEpsilonAt(aF); return -im / re; }
  GetEpsilonInf(): number { return this.epsInf; }
  GetM(): number { return this.m; }
  IsLossless(): boolean { return this.lossless; }
}

// ---------------------------------------------------------------- TRANSLINE_CALCULATION_BASE
export type TranslineResults = Map<TCP, [number, TRANSLINE_STATUS]>;
/** std::unordered_map::operator[] on a results map: a missing entry reads as { 0.0, OK }. */
export function resultOf(r: TranslineResults, p: TCP): [number, TRANSLINE_STATUS] {
  let v = r.get(p); if (!v) { v = [0.0, TRANSLINE_STATUS.OK]; r.set(p, v); } return v;
}
export abstract class TRANSLINE_CALCULATION_BASE {
  protected m_parameters = new Map<TCP, number>();
  protected m_analysisStatus: TranslineResults = new Map();
  protected m_synthesisStatus: TranslineResults = new Map();
  protected static readonly m_maxError = 0.000001;
  protected m_synthesizeTarget = TCP.UNKNOWN_ID;
  protected m_dsModel: DIELECTRIC_DJORDJEVIC_SARKAR | null = null;

  constructor(aParameters: TCP[]) { for (const p of aParameters) this.m_parameters.set(p, 0.0); }
  /** SetParameter: m_parameters.at( aParam ) = aValue (only the calculation's own parameters) */
  SetParameter(aParam: TCP, aValue: number): void { if (!this.m_parameters.has(aParam)) throw new RangeError(`unknown transline parameter ${TCP[aParam]}`); this.m_parameters.set(aParam, aValue); }
  GetParameter(aParam: TCP): number { const v = this.m_parameters.get(aParam); if (v === undefined) throw new RangeError(`unknown transline parameter ${TCP[aParam]}`); return v; }
  /** GetParameterRef's operator[]: a missing parameter is added as 0 */
  protected refGet(aParam: TCP): number { if (!this.m_parameters.has(aParam)) this.m_parameters.set(aParam, 0.0); return this.m_parameters.get(aParam)!; }
  protected refSet(aParam: TCP, v: number): void { this.m_parameters.set(aParam, v); }
  GetAnalysisResults(): TranslineResults { this.SetAnalysisResults(); return this.m_analysisStatus; }
  GetSynthesisResults(): TranslineResults { this.SetSynthesisResults(); return this.m_synthesisStatus; }
  abstract Analyse(): void;
  abstract Synthesize(aOpts: SYNTHESIZE_OPTS): boolean;
  SetSynthesizeTarget(aTarget: TCP): void { this.m_synthesizeTarget = aTarget; }
  GetSynthesizeTarget(): TCP { return this.m_synthesizeTarget; }

  UpdateDielectricModel(): void {
    const selected = Math.trunc(this.GetParameter(TCP.DIELECTRIC_MODEL_SEL));
    if (selected !== DIELECTRIC_MODEL.DJORDJEVIC_SARKAR) { this.m_dsModel = null; return; }
    const epsRSpec = this.GetParameter(TCP.EPSILONR), tanDSpec = this.GetParameter(TCP.TAND), fSpec = this.GetParameter(TCP.EPSILONR_SPEC_FREQ);
    if (!isfinite(fSpec) || fSpec <= 0.0) { this.m_dsModel = null; return; }
    try { const ds = new DIELECTRIC_DJORDJEVIC_SARKAR(); ds.Fit(epsRSpec, tanDSpec, fSpec); this.m_dsModel = ds; } catch { this.m_dsModel = null; }
  }
  GetDispersedEpsilonR(aF: number): number { return this.m_dsModel ? this.m_dsModel.EpsilonRealAt(aF) : this.GetParameter(TCP.EPSILONR); }
  GetDispersedTanDelta(aF: number): number { return this.m_dsModel ? this.m_dsModel.TanDeltaAt(aF) : this.GetParameter(TCP.TAND); }
  GetSoldermaskDeltaQ(_aWOverH: number, _aCOverH: number): number { return 0.0; }

  static WanHoorfarQ2(aU: number, aHBarTop: number): number {
    const wBarEff = aU + (2.0 / PI) * Math.log(17.08 * (0.5 * aU + 0.92));
    const denom = wBarEff * PI - 4.0;
    if (denom <= 0.0 || !isfinite(denom)) return 0.0;
    const vBar = (2.0 / PI) * Math.atan((2.0 * PI / denom) * (aHBarTop - 1.0));
    const halfPi = 0.5 * PI * vBar;
    if (aU >= 1.0) {
      const q1 = 1.0 - Math.log(wBarEff * PI - 1.0) / (2.0 * wBarEff);
      const inner = 2.0 * wBarEff * Math.cos(halfPi) / (2.0 * aHBarTop - 1.0 + vBar) + Math.sin(halfPi);
      if (inner <= 0.0 || !isfinite(inner)) return 0.0;
      const correction = (1.0 - vBar) / (2.0 * wBarEff) * Math.log(inner);
      return Math.max(0.0, 1.0 - q1 - correction);
    }
    const logStrip = Math.log(8.0 / aU);
    if (!isfinite(logStrip) || logStrip <= 0.0) return 0.0;
    const q1 = 0.5 + 0.9 / (PI * logStrip);
    const bj = (aHBarTop + 1.0) / (aHBarTop + 0.25 * aU - 1.0);
    if (bj <= 0.0 || !isfinite(bj)) return 0.0;
    const acosArg = Math.sqrt(bj) * (aHBarTop - 1.0 + 0.125 * aU) / aHBarTop;
    if (!isfinite(acosArg)) return 0.0;
    const correction = (Math.log(bj) * Math.acos(Math.min(1.0, Math.max(-1.0, acosArg)))) / (4.0 * logStrip);
    return Math.max(0.0, 1.0 - q1 - correction);
  }

  ApplySoldermaskCorrection(aEpsEffUncoated: number, aTanDeltaSubstrate: number, aEpsRSubstrate: number, aWOverH: number, _aF: number): [number, number] {
    if (this.GetParameter(TCP.SOLDERMASK_PRESENT) < 0.5) return [aEpsEffUncoated, aTanDeltaSubstrate];
    const C = this.GetParameter(TCP.SOLDERMASK_THICKNESS), h = this.GetParameter(TCP.H);
    if (C <= 0.0 || h <= 0.0 || !isfinite(C) || !isfinite(h)) return [aEpsEffUncoated, aTanDeltaSubstrate];
    const epsMask = this.GetParameter(TCP.SOLDERMASK_EPSILONR), tanDMask = this.GetParameter(TCP.SOLDERMASK_TAND);
    if (!isfinite(epsMask) || epsMask <= 1.0) return [aEpsEffUncoated, aTanDeltaSubstrate];
    if (!isfinite(tanDMask) || tanDMask < 0.0) return [aEpsEffUncoated, aTanDeltaSubstrate];
    if (aEpsRSubstrate <= 1.0 || !isfinite(aEpsRSubstrate)) return [aEpsEffUncoated, aTanDeltaSubstrate];
    const deltaQ = this.GetSoldermaskDeltaQ(aWOverH, C / h);
    if (deltaQ <= 0.0) return [aEpsEffUncoated, aTanDeltaSubstrate];
    const epsEffCoated = aEpsEffUncoated + deltaQ * (epsMask - 1.0);
    const qSub = Math.min(1.0, Math.max(0.0, (aEpsEffUncoated - 1.0) / (aEpsRSubstrate - 1.0)));
    const deltaQCapped = Math.min(deltaQ, Math.max(0.0, 1.0 - qSub));
    let tanDCoated = aTanDeltaSubstrate;
    if (epsEffCoated > 0.0) tanDCoated = (qSub * aEpsRSubstrate * aTanDeltaSubstrate + deltaQCapped * epsMask * tanDMask) / epsEffCoated;
    return [epsEffCoated, tanDCoated];
  }

  protected abstract SetAnalysisResults(): void;
  protected abstract SetSynthesisResults(): void;
  protected SetAnalysisResult(aParam: TCP, aValue: number, aStatus = TRANSLINE_STATUS.OK): void { this.m_analysisStatus.set(aParam, [aValue, aStatus]); }
  protected SetSynthesisResult(aParam: TCP, aValue: number, aStatus = TRANSLINE_STATUS.OK): void { this.m_synthesisStatus.set(aParam, [aValue, aStatus]); }

  /** minimizeZ0Error1D: Newton's method on one parameter until Z0 (aMeasure) is within m_maxError, at most 251 steps. */
  protected MinimiseZ0Error1D(aOptimise: TCP, aMeasure: TCP, aRecalculateLength = false): boolean {
    if (!isfinite(this.refGet(aMeasure))) { this.refSet(aOptimise, NaN); return false; }
    if (!isfinite(this.refGet(aOptimise)) || this.refGet(aOptimise) === 0) this.refSet(aOptimise, 0.001);
    const Z0_dest = this.refGet(aMeasure);
    const angl_l_dest = this.refGet(TCP.ANG_L);
    let iteration = 0;
    this.Analyse();
    let Z0_current = this.refGet(aMeasure);
    let error = Math.abs(Z0_dest - Z0_current);
    while (error > TRANSLINE_CALCULATION_BASE.m_maxError) {
      iteration++;
      const increment = this.refGet(aOptimise) / 100.0;
      this.refSet(aOptimise, this.refGet(aOptimise) + increment);
      this.Analyse();
      const Z0_result = this.refGet(aMeasure);
      let slope = (Z0_result - Z0_current) / increment;
      slope = (Z0_dest - Z0_current) / slope - increment;
      this.refSet(aOptimise, this.refGet(aOptimise) + slope);
      if (this.refGet(aOptimise) <= 0.0) this.refSet(aOptimise, increment);
      this.Analyse();
      Z0_current = this.refGet(aMeasure);
      error = Math.abs(Z0_dest - Z0_current);
      if (iteration > 250) break;
    }
    if (aRecalculateLength) {
      this.refSet(aMeasure, Z0_dest); this.refSet(TCP.ANG_L, angl_l_dest);
      this.SetParameter(TCP.PHYS_LEN, C0 / this.GetParameter(TCP.FREQUENCY) / Math.sqrt(this.GetParameter(TCP.EPSILON_EFF)) * this.refGet(TCP.ANG_L) / 2.0 / PI);
      this.Analyse();
      this.refSet(aMeasure, Z0_dest); this.refSet(TCP.ANG_L, angl_l_dest);
      this.SetParameter(TCP.PHYS_LEN, C0 / this.GetParameter(TCP.FREQUENCY) / Math.sqrt(this.GetParameter(TCP.EPSILON_EFF)) * this.refGet(TCP.ANG_L) / 2.0 / PI);
    }
    return error <= TRANSLINE_CALCULATION_BASE.m_maxError;
  }
  SkinDepth(): number { return 1.0 / Math.sqrt(PI * this.GetParameter(TCP.FREQUENCY) * this.GetParameter(TCP.MURC) * MU0 * this.GetParameter(TCP.SIGMA)); }
  /** The unit propagation delay (ps/cm) for an effective permittivity */
  static UnitPropagationDelay(aEpsilonEff: number): number { return Math.sqrt(aEpsilonEff) * (1.0e10 / 2.99e8); }
  /** Complete elliptic integrals [K, E] by the arithmetic-geometric mean (Abramowitz and Stegun) */
  static EllipticIntegral(arg: number): [number, number] {
    const NR_EPSI = 2.2204460492503131e-16, iMax = 16;
    let k = 0.0, e = 0.0;
    if (arg === 1.0) { k = Infinity; e = 0; }
    else if (arg === -Infinity) { k = 0; e = Infinity; }
    else {
      let a: number, b: number, c: number, fr: number, s: number, fk = 1, fe = 1, t: number, da = arg, i: number;
      if (arg < 0) { fk = 1 / Math.sqrt(1 - arg); fe = Math.sqrt(1 - arg); da = -arg / (1 - arg); }
      a = 1; b = Math.sqrt(1 - da); c = Math.sqrt(da); fr = 0.5; s = fr * c * c;
      for (i = 0; i < iMax; i++) {
        t = (a + b) / 2; c = (a - b) / 2; b = Math.sqrt(a * b); a = t; fr *= 2; s += fr * c * c;
        if (c / a < NR_EPSI) break;
      }
      if (i >= iMax) { k = 0; e = 0; }
      else { k = M_PI_2 / a; e = M_PI_2 * (1 - s) / a; if (arg < 0) { k *= fk; e *= fe; } }
    }
    return [k, e];
  }
  static coth(x: number): number { return (Math.exp(2.0 * x) + 1.0) / (Math.exp(2.0 * x) - 1.0); }
  static sech(x: number): number { return 2.0 / (Math.exp(x) + Math.exp(-x)); }
}
const UnitPropagationDelay = TRANSLINE_CALCULATION_BASE.UnitPropagationDelay;
const EllipticIntegral = TRANSLINE_CALCULATION_BASE.EllipticIntegral;

// ---------------------------------------------------------------- MICROSTRIP
const pow = Math.pow, exp = Math.exp, log = Math.log, sqrt = Math.sqrt, tanh = Math.tanh, cosh = Math.cosh, atan = Math.atan;
export class MICROSTRIP extends TRANSLINE_CALCULATION_BASE {
  Z0_0 = 0.0; er_eff_0 = 0.0; mur_eff = 0.0; w_eff = 0.0; Z0_h_1 = 0.0;
  constructor() {
    super([TCP.EPSILONR, TCP.H_T, TCP.H, TCP.PHYS_WIDTH, TCP.T, TCP.Z0, TCP.FREQUENCY, TCP.EPSILON_EFF, TCP.SKIN_DEPTH, TCP.SIGMA, TCP.ROUGH,
      TCP.TAND, TCP.PHYS_LEN, TCP.MUR, TCP.MURC, TCP.ANG_L, TCP.UNIT_PROP_DELAY, TCP.ATTEN_COND, TCP.ATTEN_DILECTRIC,
      TCP.DIELECTRIC_MODEL_SEL, TCP.EPSILONR_SPEC_FREQ, TCP.SOLDERMASK_PRESENT, TCP.SOLDERMASK_THICKNESS, TCP.SOLDERMASK_EPSILONR, TCP.SOLDERMASK_TAND]);
  }
  override GetSoldermaskDeltaQ(aWOverH: number, aCOverH: number): number {
    if (aWOverH <= 0.0 || aCOverH <= 0.0) return 0.0;
    const q2Coated = TRANSLINE_CALCULATION_BASE.WanHoorfarQ2(aWOverH, 1.0 + aCOverH), q2Base = TRANSLINE_CALCULATION_BASE.WanHoorfarQ2(aWOverH, 1.0);
    return Math.max(0.0, q2Coated - q2Base);
  }
  Analyse(): void {
    this.UpdateDielectricModel();
    const f = this.GetParameter(TCP.FREQUENCY), rawEpsR = this.GetParameter(TCP.EPSILONR), rawTanD = this.GetParameter(TCP.TAND);
    this.SetParameter(TCP.EPSILONR, this.GetDispersedEpsilonR(f));
    this.SetParameter(TCP.TAND, this.GetDispersedTanDelta(f));
    this.mur_eff_ms();
    this.microstrip_Z0();
    const erEffUncoated = this.er_eff_0, dispersedEpsR = this.GetParameter(TCP.EPSILONR), dispersedTanD = this.GetParameter(TCP.TAND);
    const uOverH = this.GetParameter(TCP.PHYS_WIDTH) / this.GetParameter(TCP.H);
    const [erEffCoated, tanDCoated] = this.ApplySoldermaskCorrection(erEffUncoated, dispersedTanD, dispersedEpsR, uOverH, f);
    if (erEffCoated !== erEffUncoated) { this.er_eff_0 = erEffCoated; this.Z0_0 *= sqrt(erEffUncoated / erEffCoated); this.SetParameter(TCP.Z0, this.Z0_0); }
    this.dispersion();
    this.line_angle();
    this.SetParameter(TCP.TAND, tanDCoated);
    this.attenuation();
    this.SetParameter(TCP.EPSILONR, rawEpsR);
    this.SetParameter(TCP.TAND, rawTanD);
  }
  Synthesize(_aOpts: SYNTHESIZE_OPTS): boolean {
    const z0_dest = this.GetParameter(TCP.Z0), angl_dest = this.GetParameter(TCP.ANG_L);
    this.SetParameter(TCP.PHYS_WIDTH, this.SynthesizeWidth());
    if (!this.MinimiseZ0Error1D(TCP.PHYS_WIDTH, TCP.Z0)) return false;
    this.SetParameter(TCP.Z0, z0_dest);
    this.SetParameter(TCP.ANG_L, angl_dest);
    const er_eff = this.GetParameter(TCP.EPSILON_EFF);
    this.SetParameter(TCP.PHYS_LEN, C0 / this.GetParameter(TCP.FREQUENCY) / sqrt(er_eff * this.mur_eff) * this.GetParameter(TCP.ANG_L) / 2.0 / PI);
    this.Analyse();
    this.SetParameter(TCP.Z0, z0_dest);
    this.SetParameter(TCP.ANG_L, angl_dest);
    this.SetParameter(TCP.PHYS_LEN, C0 / this.GetParameter(TCP.FREQUENCY) / sqrt(er_eff * this.mur_eff) * this.GetParameter(TCP.ANG_L) / 2.0 / PI);
    return true;
  }
  protected SetAnalysisResults(): void {
    this.SetAnalysisResult(TCP.EPSILON_EFF, this.GetParameter(TCP.EPSILON_EFF));
    this.SetAnalysisResult(TCP.UNIT_PROP_DELAY, this.GetParameter(TCP.UNIT_PROP_DELAY));
    this.SetAnalysisResult(TCP.ATTEN_COND, this.GetParameter(TCP.ATTEN_COND));
    this.SetAnalysisResult(TCP.ATTEN_DILECTRIC, this.GetParameter(TCP.ATTEN_DILECTRIC));
    this.SetAnalysisResult(TCP.SKIN_DEPTH, this.GetParameter(TCP.SKIN_DEPTH));
    const Z0 = this.GetParameter(TCP.Z0), ANG_L = this.GetParameter(TCP.ANG_L), L = this.GetParameter(TCP.PHYS_LEN), W = this.GetParameter(TCP.PHYS_WIDTH);
    const S = TRANSLINE_STATUS;
    this.SetAnalysisResult(TCP.Z0, Z0, !isfinite(Z0) || Z0 < 0 ? S.TS_ERROR : S.OK);
    this.SetAnalysisResult(TCP.ANG_L, ANG_L, !isfinite(ANG_L) || ANG_L < 0 ? S.TS_ERROR : S.OK);
    this.SetAnalysisResult(TCP.PHYS_LEN, L, !isfinite(L) || L < 0 ? S.WARNING : S.OK);
    this.SetAnalysisResult(TCP.PHYS_WIDTH, W, !isfinite(W) || W <= 0 ? S.WARNING : S.OK);
  }
  protected SetSynthesisResults(): void {
    this.SetSynthesisResult(TCP.EPSILON_EFF, this.GetParameter(TCP.EPSILON_EFF));
    this.SetSynthesisResult(TCP.UNIT_PROP_DELAY, this.GetParameter(TCP.UNIT_PROP_DELAY));
    this.SetSynthesisResult(TCP.ATTEN_COND, this.GetParameter(TCP.ATTEN_COND));
    this.SetSynthesisResult(TCP.ATTEN_DILECTRIC, this.GetParameter(TCP.ATTEN_DILECTRIC));
    this.SetSynthesisResult(TCP.SKIN_DEPTH, this.GetParameter(TCP.SKIN_DEPTH));
    const Z0 = this.GetParameter(TCP.Z0), ANG_L = this.GetParameter(TCP.ANG_L), L = this.GetParameter(TCP.PHYS_LEN), W = this.GetParameter(TCP.PHYS_WIDTH);
    const S = TRANSLINE_STATUS;
    this.SetSynthesisResult(TCP.Z0, Z0, !isfinite(Z0) || Z0 < 0 ? S.WARNING : S.OK);
    this.SetSynthesisResult(TCP.ANG_L, ANG_L, !isfinite(ANG_L) || ANG_L < 0 ? S.WARNING : S.OK);
    this.SetSynthesisResult(TCP.PHYS_LEN, L, !isfinite(L) || L < 0 ? S.TS_ERROR : S.OK);
    this.SetSynthesisResult(TCP.PHYS_WIDTH, W, !isfinite(W) || W <= 0 ? S.TS_ERROR : S.OK);
  }
  SynthesizeWidth(): number {
    const e_r = this.GetParameter(TCP.EPSILONR);
    const a = ((this.GetParameter(TCP.Z0) / ZF0 / 2 / PI) * sqrt((e_r + 1) / 2.)) + ((e_r - 1) / (e_r + 1) * (0.23 + (0.11 / e_r)));
    const b = ZF0 / 2 * PI / (this.GetParameter(TCP.Z0) * sqrt(e_r));
    let w_h: number;
    if (a > 1.52) w_h = 8 * exp(a) / (exp(2. * a) - 2);
    else w_h = (2. / PI) * (b - 1. - log((2 * b) - 1.) + ((e_r - 1) / (2 * e_r)) * (log(b - 1.) + 0.39 - 0.61 / e_r));
    return this.GetParameter(TCP.H) > 0.0 ? w_h * this.GetParameter(TCP.H) : 0;
  }
  static Z0_dispersion(u: number, e_r: number, e_r_eff_0: number, e_r_eff_f: number, f_n: number): number {
    const R_1 = 0.03891 * pow(e_r, 1.4);
    const R_2 = 0.267 * pow(u, 7.0);
    const R_3 = 4.766 * exp(-3.228 * pow(u, 0.641));
    const R_4 = 0.016 + pow(0.0514 * e_r, 4.524);
    const R_5 = pow(f_n / 28.843, 12.0);
    const R_6 = 22.2 * pow(u, 1.92);
    const R_7 = 1.206 - 0.3144 * exp(-R_1) * (1.0 - exp(-R_2));
    const R_8 = 1.0 + 1.275 * (1.0 - exp(-0.004625 * R_3 * pow(e_r, 1.674) * pow(f_n / 18.365, 2.745)));
    let tmpf = pow(e_r - 1.0, 6.0);
    const R_9 = 5.086 * R_4 * (R_5 / (0.3838 + 0.386 * R_4)) * (exp(-R_6) / (1.0 + 1.2992 * R_5)) * (tmpf / (1.0 + 10.0 * tmpf));
    const R_10 = 0.00044 * pow(e_r, 2.136) + 0.0184;
    tmpf = pow(f_n / 19.47, 6.0);
    const R_11 = tmpf / (1.0 + 0.0962 * tmpf);
    const R_12 = 1.0 / (1.0 + 0.00245 * u * u);
    const R_13 = 0.9408 * pow(e_r_eff_f, R_8) - 0.9603;
    const R_14 = (0.9408 - R_9) * pow(e_r_eff_0, R_8) - 0.9603;
    const R_15 = 0.707 * R_10 * pow(f_n / 12.3, 1.097);
    const R_16 = 1.0 + 0.0503 * e_r * e_r * R_11 * (1.0 - exp(-pow(u / 15.0, 6.0)));
    const R_17 = R_7 * (1.0 - 1.1241 * (R_12 / R_16) * exp(-0.026 * pow(f_n, 1.15656) - R_15));
    return pow(R_13 / R_14, R_17);
  }
  static Z0_homogeneous(u: number): number {
    const freq = 6.0 + (2.0 * PI - 6.0) * exp(-pow(30.666 / u, 0.7528));
    return (ZF0 / (2.0 * PI)) * log(freq / u + sqrt(1.0 + 4.0 / (u * u)));
  }
  static delta_Z0_cover(u: number, h2h: number): number {
    const h2hp1 = 1.0 + h2h;
    const P = 270.0 * (1.0 - tanh(0.28 + 1.2 * sqrt(h2h)));
    const qArg = (0.48 * sqrt(Math.max(0.0, u - 1.0))) / (h2hp1 * h2hp1);
    if (qArg >= 1.0) return P;
    const Q = 1.0 - Math.atanh(qArg);
    return P * Q;
  }
  static filling_factor(u: number, e_r: number): number {
    const u2 = u * u, u3 = u2 * u, u4 = u3 * u;
    const a = 1.0 + log((u4 + u2 / 2704) / (u4 + 0.432)) / 49.0 + log(1.0 + u3 / 5929.741) / 18.7;
    const b = 0.564 * pow((e_r - 0.9) / (e_r + 3.0), 0.053);
    return pow(1.0 + 10.0 / u, -a * b);
  }
  static delta_q_cover(h2h: number): number { return tanh(1.043 + 0.121 * h2h - 1.164 / h2h); }
  static delta_q_thickness(u: number, t_h: number): number { return (2.0 * log(2.0) / PI) * (t_h / sqrt(u)); }
  static e_r_effective(e_r: number, q: number): number { return 0.5 * (e_r + 1.0) + 0.5 * q * (e_r - 1.0); }
  static delta_u_thickness(u: number, t_h: number, e_r: number): number {
    let delta_u: number;
    if (t_h > 0.0) {
      delta_u = (t_h / PI) * log(1.0 + (4.0 * Math.E) * pow(tanh(sqrt(6.517 * u)), 2.0) / t_h);
      delta_u = 0.5 * delta_u * (1.0 + 1.0 / cosh(sqrt(e_r - 1.0)));
    } else delta_u = 0.0;
    return delta_u;
  }
  static e_r_dispersion(u: number, e_r: number, f_n: number): number {
    const P_1 = 0.27488 + u * (0.6315 + 0.525 / pow(1.0 + 0.0157 * f_n, 20.0)) - 0.065683 * exp(-8.7513 * u);
    const P_2 = 0.33622 * (1.0 - exp(-0.03442 * e_r));
    const P_3 = 0.0363 * exp(-4.6 * u) * (1.0 - exp(-pow(f_n / 38.7, 4.97)));
    const P_4 = 1.0 + 2.751 * (1.0 - exp(-pow(e_r / 15.916, 8.0)));
    return P_1 * P_2 * pow((P_3 * P_4 + 0.1844) * f_n, 1.5763);
  }
  conductor_losses(): number {
    let alpha_c: number;
    const e_r_eff_0 = this.er_eff_0, delta = this.GetParameter(TCP.SKIN_DEPTH);
    if (this.GetParameter(TCP.FREQUENCY) > 0.0) {
      const K = exp(-1.2 * pow(this.Z0_h_1 / ZF0, 0.7));
      let R_s = 1.0 / (this.GetParameter(TCP.SIGMA) * delta);
      R_s *= 1.0 + ((2.0 / PI) * atan(1.40 * pow((this.GetParameter(TCP.ROUGH) / delta), 2.0)));
      const Q_c = (PI * this.Z0_h_1 * this.GetParameter(TCP.PHYS_WIDTH) * this.GetParameter(TCP.FREQUENCY)) / (R_s * C0 * K);
      alpha_c = (20.0 * PI / log(10.0)) * this.GetParameter(TCP.FREQUENCY) * sqrt(e_r_eff_0) / (C0 * Q_c);
    } else alpha_c = 0.0;
    return alpha_c;
  }
  dielectric_losses(): number {
    const e_r = this.GetParameter(TCP.EPSILONR), e_r_eff_0 = this.er_eff_0;
    return (20.0 * PI / log(10.0)) * (this.GetParameter(TCP.FREQUENCY) / C0) * (e_r / sqrt(e_r_eff_0)) * ((e_r_eff_0 - 1.0) / (e_r - 1.0)) * this.GetParameter(TCP.TAND);
  }
  microstrip_Z0(): void {
    const e_r = this.GetParameter(TCP.EPSILONR), h2 = this.GetParameter(TCP.H_T), h2h = h2 / this.GetParameter(TCP.H);
    let u = this.GetParameter(TCP.PHYS_WIDTH) / this.GetParameter(TCP.H);
    const t_h = this.GetParameter(TCP.T) / this.GetParameter(TCP.H);
    const delta_u_1 = MICROSTRIP.delta_u_thickness(u, t_h, 1.0);
    this.Z0_h_1 = MICROSTRIP.Z0_homogeneous(u + delta_u_1);
    const delta_u_r = MICROSTRIP.delta_u_thickness(u, t_h, e_r);
    u += delta_u_r;
    const Z0_h_r = MICROSTRIP.Z0_homogeneous(u);
    const q_inf = MICROSTRIP.filling_factor(u, e_r);
    const q_c = MICROSTRIP.delta_q_cover(h2h);
    const q_t = MICROSTRIP.delta_q_thickness(u, t_h);
    const q = (q_inf - q_t) * q_c;
    const e_r_eff_t = MICROSTRIP.e_r_effective(e_r, q);
    const e_r_eff = e_r_eff_t * pow(this.Z0_h_1 / Z0_h_r, 2.0);
    this.SetParameter(TCP.Z0, (Z0_h_r - MICROSTRIP.delta_Z0_cover(u, h2h)) / sqrt(e_r_eff_t));
    this.w_eff = u * this.GetParameter(TCP.H);
    this.er_eff_0 = e_r_eff;
    this.Z0_0 = this.GetParameter(TCP.Z0);
  }
  dispersion(): void {
    const e_r = this.GetParameter(TCP.EPSILONR), e_r_eff_0 = this.er_eff_0, u = this.GetParameter(TCP.PHYS_WIDTH) / this.GetParameter(TCP.H);
    const f_n = this.GetParameter(TCP.FREQUENCY) * this.GetParameter(TCP.H) / 1e06;
    const P = MICROSTRIP.e_r_dispersion(u, e_r, f_n);
    const e_r_eff_f = e_r - (e_r - e_r_eff_0) / (1.0 + P);
    const D = MICROSTRIP.Z0_dispersion(u, e_r, e_r_eff_0, e_r_eff_f, f_n);
    const Z0_f = this.Z0_0 * D;
    this.SetParameter(TCP.UNIT_PROP_DELAY, UnitPropagationDelay(e_r_eff_f));
    this.SetParameter(TCP.EPSILON_EFF, e_r_eff_f);
    this.SetParameter(TCP.Z0, Z0_f);
  }
  attenuation(): void {
    this.SetParameter(TCP.SKIN_DEPTH, this.SkinDepth());
    this.SetParameter(TCP.ATTEN_COND, this.conductor_losses() * this.GetParameter(TCP.PHYS_LEN));
    this.SetParameter(TCP.ATTEN_DILECTRIC, this.dielectric_losses() * this.GetParameter(TCP.PHYS_LEN));
  }
  mur_eff_ms(): void {
    const mur = this.GetParameter(TCP.MUR), h = this.GetParameter(TCP.H), w = this.GetParameter(TCP.PHYS_WIDTH);
    this.mur_eff = (2.0 * mur) / ((1.0 + mur) + ((1.0 - mur) * pow((1.0 + (10.0 * h / w)), -0.5)));
  }
  line_angle(): void {
    const e_r_eff = this.GetParameter(TCP.EPSILON_EFF);
    const v = C0 / sqrt(e_r_eff * this.mur_eff);
    const lambda_g = v / this.GetParameter(TCP.FREQUENCY);
    this.SetParameter(TCP.ANG_L, 2.0 * PI * this.GetParameter(TCP.PHYS_LEN) / lambda_g);
  }
}

// ---------------------------------------------------------------- STRIPLINE
export class STRIPLINE extends TRANSLINE_CALCULATION_BASE {
  private unit_prop_delay = 0.0;
  constructor() {
    super([TCP.SKIN_DEPTH, TCP.EPSILON_EFF, TCP.EPSILONR, TCP.T, TCP.STRIPLINE_A, TCP.H, TCP.Z0, TCP.LOSS_CONDUCTOR, TCP.PHYS_LEN, TCP.LOSS_DIELECTRIC,
      TCP.FREQUENCY, TCP.TAND, TCP.PHYS_WIDTH, TCP.UNIT_PROP_DELAY, TCP.ANG_L, TCP.SIGMA, TCP.MURC, TCP.DIELECTRIC_MODEL_SEL, TCP.EPSILONR_SPEC_FREQ]);
  }
  Analyse(): void {
    this.UpdateDielectricModel();
    const f = this.GetParameter(TCP.FREQUENCY), rawEpsR = this.GetParameter(TCP.EPSILONR), rawTanD = this.GetParameter(TCP.TAND);
    this.SetParameter(TCP.EPSILONR, this.GetDispersedEpsilonR(f));
    this.SetParameter(TCP.TAND, this.GetDispersedTanDelta(f));
    this.SetParameter(TCP.SKIN_DEPTH, this.SkinDepth());
    this.SetParameter(TCP.EPSILON_EFF, this.GetParameter(TCP.EPSILONR));
    const t = this.GetParameter(TCP.T), a = this.GetParameter(TCP.STRIPLINE_A), h = this.GetParameter(TCP.H);
    const [z1, ac1] = this.lineImpedance(2.0 * a + t), [z2, ac2] = this.lineImpedance(2.0 * (h - a) - t);
    this.SetParameter(TCP.Z0, 2.0 / (1.0 / z1 + 1.0 / z2));
    this.SetParameter(TCP.LOSS_CONDUCTOR, this.GetParameter(TCP.PHYS_LEN) * (ac1 + ac2));
    this.SetParameter(TCP.LOSS_DIELECTRIC, LOG2DB * this.GetParameter(TCP.PHYS_LEN) * (PI / C0) * this.GetParameter(TCP.FREQUENCY) * sqrt(this.GetParameter(TCP.EPSILONR)) * this.GetParameter(TCP.TAND));
    this.SetParameter(TCP.ANG_L, 2.0 * PI * this.GetParameter(TCP.PHYS_LEN) * sqrt(this.GetParameter(TCP.EPSILONR)) * this.GetParameter(TCP.FREQUENCY) / C0);
    this.unit_prop_delay = UnitPropagationDelay(this.GetParameter(TCP.EPSILON_EFF));
    this.SetParameter(TCP.EPSILONR, rawEpsR);
    this.SetParameter(TCP.TAND, rawTanD);
  }
  Synthesize(_aOpts: SYNTHESIZE_OPTS): boolean { return this.MinimiseZ0Error1D(TCP.PHYS_WIDTH, TCP.Z0); }
  protected SetAnalysisResults(): void {
    this.SetAnalysisResult(TCP.EPSILON_EFF, this.GetParameter(TCP.EPSILON_EFF));
    this.SetAnalysisResult(TCP.UNIT_PROP_DELAY, this.unit_prop_delay);
    this.SetAnalysisResult(TCP.LOSS_CONDUCTOR, this.GetParameter(TCP.LOSS_CONDUCTOR));
    this.SetAnalysisResult(TCP.LOSS_DIELECTRIC, this.GetParameter(TCP.LOSS_DIELECTRIC));
    this.SetAnalysisResult(TCP.SKIN_DEPTH, this.GetParameter(TCP.SKIN_DEPTH));
    const Z0 = this.GetParameter(TCP.Z0), ANG_L = this.GetParameter(TCP.ANG_L), L = this.GetParameter(TCP.PHYS_LEN), W = this.GetParameter(TCP.PHYS_WIDTH);
    const A = this.GetParameter(TCP.STRIPLINE_A), T = this.GetParameter(TCP.T), H = this.GetParameter(TCP.H);
    const S = TRANSLINE_STATUS;
    const ATH_invalid = !isfinite(A) || !isfinite(T) || A + T >= H;
    this.SetAnalysisResult(TCP.Z0, Z0, (!isfinite(Z0) || Z0 < 0) || ATH_invalid ? S.TS_ERROR : S.OK);
    this.SetAnalysisResult(TCP.ANG_L, ANG_L, !isfinite(ANG_L) || ANG_L < 0 ? S.TS_ERROR : S.OK);
    this.SetAnalysisResult(TCP.PHYS_LEN, L, !isfinite(L) || L < 0 ? S.WARNING : S.OK);
    this.SetAnalysisResult(TCP.PHYS_WIDTH, W, !isfinite(W) || W <= 0 ? S.WARNING : S.OK);
    this.SetAnalysisResult(TCP.STRIPLINE_A, A, ATH_invalid ? S.WARNING : S.OK);
    this.SetAnalysisResult(TCP.T, T, ATH_invalid ? S.WARNING : S.OK);
    this.SetAnalysisResult(TCP.H, H, ATH_invalid ? S.WARNING : S.OK);
  }
  protected SetSynthesisResults(): void {
    this.SetSynthesisResult(TCP.EPSILON_EFF, this.GetParameter(TCP.EPSILON_EFF));
    this.SetSynthesisResult(TCP.UNIT_PROP_DELAY, this.unit_prop_delay);
    this.SetSynthesisResult(TCP.LOSS_CONDUCTOR, this.GetParameter(TCP.LOSS_CONDUCTOR));
    this.SetSynthesisResult(TCP.LOSS_DIELECTRIC, this.GetParameter(TCP.LOSS_DIELECTRIC));
    this.SetSynthesisResult(TCP.SKIN_DEPTH, this.GetParameter(TCP.SKIN_DEPTH));
    const Z0 = this.GetParameter(TCP.Z0), ANG_L = this.GetParameter(TCP.ANG_L), L = this.GetParameter(TCP.PHYS_LEN), W = this.GetParameter(TCP.PHYS_WIDTH);
    const S = TRANSLINE_STATUS;
    const invalid = this.GetParameter(TCP.STRIPLINE_A) + this.GetParameter(TCP.T) >= this.GetParameter(TCP.H);
    this.SetSynthesisResult(TCP.Z0, Z0, !isfinite(Z0) || Z0 < 0 ? S.WARNING : S.OK);
    this.SetSynthesisResult(TCP.ANG_L, ANG_L, !isfinite(ANG_L) || ANG_L < 0 ? S.WARNING : S.OK);
    this.SetSynthesisResult(TCP.PHYS_LEN, L, !isfinite(L) || L < 0 ? S.TS_ERROR : S.OK);
    this.SetSynthesisResult(TCP.PHYS_WIDTH, W, (!isfinite(W) || W <= 0) || invalid ? S.TS_ERROR : S.OK);
    this.SetSynthesisResult(TCP.STRIPLINE_A, this.GetParameter(TCP.STRIPLINE_A), invalid ? S.WARNING : S.OK);
    this.SetSynthesisResult(TCP.T, this.GetParameter(TCP.T), invalid ? S.WARNING : S.OK);
    this.SetSynthesisResult(TCP.H, this.GetParameter(TCP.H), invalid ? S.WARNING : S.OK);
  }
  /** The characteristic impedance and the conductor loss (dB/m) of one half: [ZL, aAc] */
  private lineImpedance(aHeight: number): [number, number] {
    let ZL: number;
    const T = this.GetParameter(TCP.T), W = this.GetParameter(TCP.PHYS_WIDTH), er = this.GetParameter(TCP.EPSILONR);
    const hmt = aHeight - T;
    let aAc = sqrt(this.GetParameter(TCP.FREQUENCY) / this.GetParameter(TCP.SIGMA) / 17.2);
    if (W / hmt >= 0.35) {
      ZL = W + (2.0 * aHeight * log((2.0 * aHeight - T) / hmt) - T * log(aHeight * aHeight / hmt / hmt - 1.0)) / PI;
      ZL = ZF0 * hmt / sqrt(er) / 4.0 / ZL;
      aAc *= 2.02e-6 * er * ZL / hmt;
      aAc *= 1.0 + 2.0 * W / hmt + (aHeight + T) / hmt / PI * log(2.0 * aHeight / T - 1.0);
    } else {
      let tdw = T / W;
      if (T / W > 1.0) tdw = W / T;
      let de = 1.0 + tdw / PI * (1.0 + log(4.0 * PI / tdw)) + 0.236 * pow(tdw, 1.65);
      if (T / W > 1.0) de *= T / 2.0; else de *= W / 2.0;
      ZL = ZF0 / 2.0 / PI / sqrt(er) * log(4.0 * aHeight / PI / de);
      aAc *= 0.01141 / ZL / de;
      aAc *= de / aHeight + 0.5 + tdw / 2.0 / PI + 0.5 / PI * log(4.0 * PI / tdw) + 0.1947 * pow(tdw, 0.65) - 0.0767 * pow(tdw, 1.65);
    }
    return [ZL, aAc];
  }
}

// ---------------------------------------------------------------- COUPLED_MICROSTRIP
export class COUPLED_MICROSTRIP extends TRANSLINE_CALCULATION_BASE {
  private m_aux_microstrip = new MICROSTRIP();
  private w_t_e = 0.0; private w_t_o = 0.0; private er_eff_e_0 = 0.0; private er_eff_o_0 = 0.0; private Z0_e_0 = 0.0; private Z0_o_0 = 0.0;
  private er_eff_e = 0.0; private er_eff_o = 0.0; private prop_delay_e = 0.0; private prop_delay_o = 0.0;
  private atten_cond_e = 0.0; private atten_cond_o = 0.0; private atten_dielectric_e = 0.0; private atten_dielectric_o = 0.0;
  private ang_l_e = 0.0; private ang_l_o = 0.0; private Zdiff = 0.0;
  constructor() {
    super([TCP.Z0_E, TCP.Z0_O, TCP.Z_DIFF, TCP.ANG_L, TCP.PHYS_WIDTH, TCP.PHYS_LEN, TCP.PHYS_S, TCP.H, TCP.T, TCP.H_T, TCP.FREQUENCY, TCP.EPSILONR,
      TCP.EPSILON_EFF_EVEN, TCP.EPSILON_EFF_ODD, TCP.UNIT_PROP_DELAY_EVEN, TCP.UNIT_PROP_DELAY_ODD, TCP.ATTEN_COND_EVEN, TCP.ATTEN_COND_ODD,
      TCP.ATTEN_DILECTRIC_EVEN, TCP.ATTEN_DILECTRIC_ODD, TCP.SKIN_DEPTH, TCP.MURC, TCP.SIGMA, TCP.ROUGH, TCP.TAND, TCP.DIELECTRIC_MODEL_SEL,
      TCP.EPSILONR_SPEC_FREQ, TCP.SOLDERMASK_PRESENT, TCP.SOLDERMASK_THICKNESS, TCP.SOLDERMASK_EPSILONR, TCP.SOLDERMASK_TAND]);
  }
  override GetSoldermaskDeltaQ(aWOverH: number, aCOverH: number): number {
    if (aWOverH <= 0.0 || aCOverH <= 0.0) return 0.0;
    const q2Coated = TRANSLINE_CALCULATION_BASE.WanHoorfarQ2(aWOverH, 1.0 + aCOverH), q2Base = TRANSLINE_CALCULATION_BASE.WanHoorfarQ2(aWOverH, 1.0);
    return Math.max(0.0, q2Coated - q2Base);
  }
  Analyse(): void {
    this.UpdateDielectricModel();
    const f = this.GetParameter(TCP.FREQUENCY), rawEpsR = this.GetParameter(TCP.EPSILONR), rawTanD = this.GetParameter(TCP.TAND);
    this.SetParameter(TCP.EPSILONR, this.GetDispersedEpsilonR(f));
    this.SetParameter(TCP.TAND, this.GetDispersedTanDelta(f));
    this.delta_u_thickness();
    this.er_eff_static();
    this.Z0_even_odd();
    const dispersedEpsR = this.GetParameter(TCP.EPSILONR), dispersedTanD = this.GetParameter(TCP.TAND);
    const uOverH = this.GetParameter(TCP.PHYS_WIDTH) / this.GetParameter(TCP.H);
    const [erEvenCoated, tanDEvenCoated] = this.ApplySoldermaskCorrection(this.er_eff_e_0, dispersedTanD, dispersedEpsR, uOverH, f);
    const [erOddCoated, tanDOddCoated] = this.ApplySoldermaskCorrection(this.er_eff_o_0, dispersedTanD, dispersedEpsR, uOverH, f);
    if (erEvenCoated !== this.er_eff_e_0) { this.Z0_e_0 *= sqrt(this.er_eff_e_0 / erEvenCoated); this.er_eff_e_0 = erEvenCoated; }
    if (erOddCoated !== this.er_eff_o_0) { this.Z0_o_0 *= sqrt(this.er_eff_o_0 / erOddCoated); this.er_eff_o_0 = erOddCoated; }
    this.er_eff_freq();
    this.Z0_dispersion();
    this.SetParameter(TCP.TAND, 0.5 * (tanDEvenCoated + tanDOddCoated));
    this.attenuation();
    this.line_angle();
    this.diff_impedance();
    this.SetParameter(TCP.EPSILONR, rawEpsR);
    this.SetParameter(TCP.TAND, rawTanD);
  }
  Synthesize(aOpts: SYNTHESIZE_OPTS): boolean {
    if (aOpts === SYNTHESIZE_OPTS.FIX_WIDTH) return this.MinimiseZ0Error1D(TCP.PHYS_S, TCP.Z0_O, false);
    if (aOpts === SYNTHESIZE_OPTS.FIX_SPACING) return this.MinimiseZ0Error1D(TCP.PHYS_WIDTH, TCP.Z0_O, false);
    const eps = 1e-04;
    const Z0_e = this.GetParameter(TCP.Z0_E), Z0_o = this.GetParameter(TCP.Z0_O);
    this.ang_l_e = this.GetParameter(TCP.ANG_L); this.ang_l_o = this.GetParameter(TCP.ANG_L);
    const ang_l_dest = this.GetParameter(TCP.ANG_L);
    this.synth_width();
    let w_h = this.GetParameter(TCP.PHYS_WIDTH) / this.GetParameter(TCP.H);
    let s_h = this.GetParameter(TCP.PHYS_S) / this.GetParameter(TCP.H);
    let f1 = 0, f2 = 0, err: number, iters = 0;
    do {
      ++iters;
      let [ft1, ft2] = this.syn_fun(s_h + eps, w_h, Z0_e, Z0_o);
      const j11 = (ft1 - f1) / eps, j21 = (ft2 - f2) / eps;
      [ft1, ft2] = this.syn_fun(s_h, w_h + eps, Z0_e, Z0_o);
      const j12 = (ft1 - f1) / eps, j22 = (ft2 - f2) / eps;
      const d_s_h = (-f1 * j22 + f2 * j12) / (j11 * j22 - j21 * j12);
      const d_w_h = (-f2 * j11 + f1 * j21) / (j11 * j22 - j21 * j12);
      s_h += d_s_h; w_h += d_w_h;
      [f1, f2] = this.syn_fun(s_h, w_h, Z0_e, Z0_o);
      err = sqrt(f1 * f1 + f2 * f2);
    } while (err > 1e-04 && iters < 250);
    if (err > 1e-04) return false;
    this.SetParameter(TCP.PHYS_S, s_h * this.GetParameter(TCP.H));
    this.SetParameter(TCP.PHYS_WIDTH, w_h * this.GetParameter(TCP.H));
    const le = C0 / this.GetParameter(TCP.FREQUENCY) / sqrt(this.er_eff_e) * ang_l_dest / 2.0 / PI;
    const lo = C0 / this.GetParameter(TCP.FREQUENCY) / sqrt(this.er_eff_o) * ang_l_dest / 2.0 / PI;
    this.SetParameter(TCP.PHYS_LEN, sqrt(le * lo));
    this.Analyse();
    this.SetParameter(TCP.ANG_L, ang_l_dest);
    this.SetParameter(TCP.Z0_E, Z0_e);
    this.SetParameter(TCP.Z0_O, Z0_o);
    return true;
  }
  private publish(set: (p: TCP, v: number, s?: TRANSLINE_STATUS) => void, imp: TRANSLINE_STATUS, geo: TRANSLINE_STATUS): void {
    set(TCP.EPSILON_EFF_EVEN, this.er_eff_e); set(TCP.EPSILON_EFF_ODD, this.er_eff_o);
    set(TCP.UNIT_PROP_DELAY_EVEN, this.prop_delay_e); set(TCP.UNIT_PROP_DELAY_ODD, this.prop_delay_o);
    set(TCP.ATTEN_COND_EVEN, this.atten_cond_e); set(TCP.ATTEN_COND_ODD, this.atten_cond_o);
    set(TCP.ATTEN_DILECTRIC_EVEN, this.atten_dielectric_e); set(TCP.ATTEN_DILECTRIC_ODD, this.atten_dielectric_o);
    set(TCP.SKIN_DEPTH, this.GetParameter(TCP.SKIN_DEPTH)); set(TCP.Z_DIFF, this.Zdiff);
    const Z0_E = this.GetParameter(TCP.Z0_E), Z0_O = this.GetParameter(TCP.Z0_O), ANG_L = sqrt(this.ang_l_e * this.ang_l_o);
    const W = this.GetParameter(TCP.PHYS_WIDTH), L = this.GetParameter(TCP.PHYS_LEN), S = this.GetParameter(TCP.PHYS_S), OK = TRANSLINE_STATUS.OK;
    set(TCP.Z0_E, Z0_E, !isfinite(Z0_E) || Z0_E <= 0 ? imp : OK);
    set(TCP.Z0_O, Z0_O, !isfinite(Z0_O) || Z0_O <= 0 ? imp : OK);
    set(TCP.ANG_L, ANG_L, !isfinite(ANG_L) || ANG_L < 0 ? imp : OK);
    set(TCP.PHYS_WIDTH, W, !isfinite(W) || W <= 0 ? geo : OK);
    set(TCP.PHYS_LEN, L, !isfinite(L) || L < 0 ? geo : OK);
    set(TCP.PHYS_S, S, !isfinite(S) || S <= 0 ? geo : OK);
  }
  protected SetAnalysisResults(): void { this.publish((p, v, s) => this.SetAnalysisResult(p, v, s), TRANSLINE_STATUS.TS_ERROR, TRANSLINE_STATUS.WARNING); }
  protected SetSynthesisResults(): void { this.publish((p, v, s) => this.SetSynthesisResult(p, v, s), TRANSLINE_STATUS.WARNING, TRANSLINE_STATUS.TS_ERROR); }
  private delta_u_thickness_single(u: number, t_h: number): number {
    if (t_h > 0.0) return (1.25 * t_h / PI) * (1.0 + log((2.0 + (4.0 * PI * u - 2.0) / (1.0 + exp(-100.0 * (u - 1.0 / (2.0 * PI))))) / t_h));
    return 0.0;
  }
  private delta_u_thickness(): void {
    const e_r = this.GetParameter(TCP.EPSILONR), H = this.GetParameter(TCP.H);
    const u = this.GetParameter(TCP.PHYS_WIDTH) / H, g = this.GetParameter(TCP.PHYS_S) / H, t_h = this.GetParameter(TCP.T) / H;
    let delta_u_e: number, delta_u_o: number;
    if (t_h > 0.0) {
      const delta_u = this.delta_u_thickness_single(u, t_h), delta_t = t_h / (g * e_r);
      delta_u_e = delta_u * (1.0 - 0.5 * exp(-0.69 * delta_u / delta_t));
      delta_u_o = delta_u_e + delta_t;
    } else delta_u_e = delta_u_o = 0.0;
    this.w_t_e = this.GetParameter(TCP.PHYS_WIDTH) + delta_u_e * H;
    this.w_t_o = this.GetParameter(TCP.PHYS_WIDTH) + delta_u_o * H;
  }
  private compute_single_line(): void {
    const m = this.m_aux_microstrip;
    m.SetParameter(TCP.EPSILONR, this.GetParameter(TCP.EPSILONR));
    m.SetParameter(TCP.PHYS_WIDTH, this.GetParameter(TCP.PHYS_WIDTH));
    m.SetParameter(TCP.H, this.GetParameter(TCP.H));
    m.SetParameter(TCP.T, 0.0);
    m.SetParameter(TCP.H_T, 1e12);
    m.SetParameter(TCP.FREQUENCY, this.GetParameter(TCP.FREQUENCY));
    m.SetParameter(TCP.MURC, this.GetParameter(TCP.MURC));
    m.microstrip_Z0();
    m.dispersion();
  }
  private filling_factor_even(u: number, g: number, e_r: number): number {
    const v = u * (20.0 + g * g) / (10.0 + g * g) + g * exp(-g), v3 = v * v * v, v4 = v3 * v;
    const a_e = 1.0 + log((v4 + v * v / 2704.0) / (v4 + 0.432)) / 49.0 + log(1.0 + v3 / 5929.741) / 18.7;
    const b_e = 0.564 * pow(((e_r - 0.9) / (e_r + 3.0)), 0.053);
    return pow((1.0 + 10.0 / v), -a_e * b_e);
  }
  private filling_factor_odd(u: number, g: number, e_r: number): number {
    const b_odd = 0.747 * e_r / (0.15 + e_r), c_odd = b_odd - (b_odd - 0.207) * exp(-0.414 * u), d_odd = 0.593 + 0.694 * exp(-0.562 * u);
    return exp(-c_odd * pow(g, d_odd));
  }
  private delta_q_cover_even(h2h: number): number { return h2h <= 39 ? tanh(1.626 + 0.107 * h2h - 1.733 / sqrt(h2h)) : 1.0; }
  private delta_q_cover_odd(h2h: number): number { return h2h <= 7 ? tanh(9.575 / (7.0 - h2h) - 2.965 + 1.68 * h2h - 0.311 * h2h * h2h) : 1.0; }
  private er_eff_static(): void {
    const er = this.GetParameter(TCP.EPSILONR);
    this.compute_single_line();
    const er_eff_single = this.m_aux_microstrip.er_eff_0;
    const H = this.GetParameter(TCP.H), h2 = this.GetParameter(TCP.H_T);
    const u_t_e = this.w_t_e / H, u_t_o = this.w_t_o / H, g = this.GetParameter(TCP.PHYS_S) / H, h2h = h2 / H, t_h = this.GetParameter(TCP.T) / H;
    let q_inf = this.filling_factor_even(u_t_e, g, er);
    let q_c = this.delta_q_cover_even(h2h);
    let q_t = MICROSTRIP.delta_q_thickness(u_t_e, t_h);
    let q = (q_inf - q_t) * q_c;
    this.er_eff_e_0 = 0.5 * (er + 1.0) + 0.5 * (er - 1.0) * q;
    q_inf = this.filling_factor_odd(u_t_o, g, er);
    q_c = this.delta_q_cover_odd(h2h);
    q_t = MICROSTRIP.delta_q_thickness(u_t_o, t_h);
    q = (q_inf - q_t) * q_c;
    const a_o = 0.7287 * (er_eff_single - 0.5 * (er + 1.0)) * (1.0 - exp(-0.179 * u_t_o));
    this.er_eff_o_0 = (0.5 * (er + 1.0) + a_o - er_eff_single) * q + er_eff_single;
  }
  private delta_Z0_even_cover(g: number, u: number, h2h: number): number {
    const A = -4.351 / pow(1.0 + h2h, 1.842), B = 6.639 / pow(1.0 + h2h, 1.861), C = -2.291 / pow(1.0 + h2h, 1.90);
    const f_e = 1.0 - Math.atanh(A + (B + C * u) * u);
    const x = pow(10.0, 0.103 * g - 0.159), y = pow(10.0, 0.0492 * g - 0.073);
    const D = 0.747 / Math.sin(0.5 * PI * x), E = 0.725 * Math.sin(0.5 * PI * y), F = pow(10.0, 0.11 - 0.0947 * g);
    const g_e = 270.0 * (1.0 - tanh(D + E * sqrt(1.0 + h2h) - F / (1.0 + h2h)));
    return f_e * g_e;
  }
  private delta_Z0_odd_cover(g: number, u: number, h2h: number): number {
    const J = tanh(pow(1.0 + h2h, 1.585) / 6.0), f_o = pow(u, J), G = 2.178 - 0.796 * g;
    const K = g > 0.858 ? Math.log10(20.492 * pow(g, 0.174)) : 1.30;
    const L = g > 0.873 ? 2.51 * pow(g, -0.462) : 2.674;
    const g_o = 270.0 * (1.0 - tanh(G + K * sqrt(1.0 + h2h) - L / (1.0 + h2h)));
    return f_o * g_o;
  }
  private Z0_even_odd(): void {
    const H = this.GetParameter(TCP.H), h2 = this.GetParameter(TCP.H_T);
    const u_t_e = this.w_t_e / H, u_t_o = this.w_t_o / H, g = this.GetParameter(TCP.PHYS_S) / H, h2h = h2 / H;
    const Z0_single = this.m_aux_microstrip.Z0_0, er_eff_single = this.m_aux_microstrip.er_eff_0;
    let er_eff = this.er_eff_e_0;
    const Q_1 = 0.8695 * pow(u_t_e, 0.194);
    const Q_2 = 1.0 + 0.7519 * g + 0.189 * pow(g, 2.31);
    const Q_3 = 0.1975 + pow((16.6 + pow((8.4 / g), 6.0)), -0.387) + log(pow(g, 10.0) / (1.0 + pow(g / 3.4, 10.0))) / 241.0;
    const Q_4 = 2.0 * Q_1 / (Q_2 * (exp(-g) * pow(u_t_e, Q_3) + (2.0 - exp(-g)) * pow(u_t_e, -Q_3)));
    this.Z0_e_0 = Z0_single * sqrt(er_eff_single / er_eff) / (1.0 - sqrt(er_eff_single) * Q_4 * Z0_single / ZF0);
    const delta_Z0_e_0 = this.delta_Z0_even_cover(g, u_t_e, h2h) / sqrt(er_eff);
    this.Z0_e_0 = this.Z0_e_0 - delta_Z0_e_0;
    er_eff = this.er_eff_o_0;
    const Q_5 = 1.794 + 1.14 * log(1.0 + 0.638 / (g + 0.517 * pow(g, 2.43)));
    const Q_6 = 0.2305 + log(pow(g, 10.0) / (1.0 + pow(g / 5.8, 10.0))) / 281.3 + log(1.0 + 0.598 * pow(g, 1.154)) / 5.1;
    const Q_7 = (10.0 + 190.0 * g * g) / (1.0 + 82.3 * g * g * g);
    const Q_8 = exp(-6.5 - 0.95 * log(g) - pow(g / 0.15, 5.0));
    const Q_9 = log(Q_7) * (Q_8 + 1.0 / 16.5);
    const Q_10 = (Q_2 * Q_4 - Q_5 * exp(log(u_t_o) * Q_6 * pow(u_t_o, -Q_9))) / Q_2;
    this.Z0_o_0 = Z0_single * sqrt(er_eff_single / er_eff) / (1.0 - sqrt(er_eff_single) * Q_10 * Z0_single / ZF0);
    const delta_Z0_o_0 = this.delta_Z0_odd_cover(g, u_t_o, h2h) / sqrt(er_eff);
    this.Z0_o_0 = this.Z0_o_0 - delta_Z0_o_0;
  }
  private er_eff_freq(): void {
    const H = this.GetParameter(TCP.H), ER = this.GetParameter(TCP.EPSILONR);
    const u = this.GetParameter(TCP.PHYS_WIDTH) / H, g = this.GetParameter(TCP.PHYS_S) / H;
    const f_n = this.GetParameter(TCP.FREQUENCY) * H / 1e06;
    let er_eff = this.er_eff_e_0;
    const P_1 = 0.27488 + (0.6315 + 0.525 / pow(1.0 + 0.0157 * f_n, 20.0)) * u - 0.065683 * exp(-8.7513 * u);
    const P_2 = 0.33622 * (1.0 - exp(-0.03442 * ER));
    const P_3 = 0.0363 * exp(-4.6 * u) * (1.0 - exp(-pow(f_n / 38.7, 4.97)));
    const P_4 = 1.0 + 2.751 * (1.0 - exp(-pow(ER / 15.916, 8.0)));
    const P_5 = 0.334 * exp(-3.3 * pow(ER / 15.0, 3.0)) + 0.746;
    const P_6 = P_5 * exp(-pow(f_n / 18.0, 0.368));
    const P_7 = 1.0 + 4.069 * P_6 * pow(g, 0.479) * exp(-1.347 * pow(g, 0.595) - 0.17 * pow(g, 2.5));
    const F_e = P_1 * P_2 * pow((P_3 * P_4 + 0.1844 * P_7) * f_n, 1.5763);
    this.er_eff_e = ER - (ER - er_eff) / (1.0 + F_e);
    this.prop_delay_e = UnitPropagationDelay(this.er_eff_e);
    er_eff = this.er_eff_o_0;
    const P_8 = 0.7168 * (1.0 + 1.076 / (1.0 + 0.0576 * (ER - 1.0)));
    const P_9 = P_8 - 0.7913 * (1.0 - exp(-pow(f_n / 20.0, 1.424))) * atan(2.481 * pow(ER / 8.0, 0.946));
    const P_10 = 0.242 * pow(ER - 1.0, 0.55);
    const P_11 = 0.6366 * (exp(-0.3401 * f_n) - 1.0) * atan(1.263 * pow(u / 3.0, 1.629));
    const P_12 = P_9 + (1.0 - P_9) / (1.0 + 1.183 * pow(u, 1.376));
    const P_13 = 1.695 * P_10 / (0.414 + 1.605 * P_10);
    const P_14 = 0.8928 + 0.1072 * (1.0 - exp(-0.42 * pow(f_n / 20.0, 3.215)));
    const P_15 = Math.abs(1.0 - 0.8928 * (1.0 + P_11) * P_12 * exp(-P_13 * pow(g, 1.092)) / P_14);
    const F_o = P_1 * P_2 * pow((P_3 * P_4 + 0.1844) * f_n * P_15, 1.5763);
    this.er_eff_o = ER - (ER - er_eff) / (1.0 + F_o);
    this.prop_delay_o = UnitPropagationDelay(this.er_eff_o);
  }
  private conductor_losses(): void {
    const e_r_eff_e_0 = this.er_eff_e_0, e_r_eff_o_0 = this.er_eff_o_0;
    const Z0_h_e = this.Z0_e_0 * sqrt(e_r_eff_e_0), Z0_h_o = this.Z0_o_0 * sqrt(e_r_eff_o_0), delta = this.GetParameter(TCP.SKIN_DEPTH);
    let alpha_c_e: number, alpha_c_o: number;
    const F = this.GetParameter(TCP.FREQUENCY), W = this.GetParameter(TCP.PHYS_WIDTH);
    if (F > 0.0) {
      const K = exp(-1.2 * pow((Z0_h_e + Z0_h_o) / (2.0 * ZF0), 0.7));
      let R_s = 1.0 / (this.GetParameter(TCP.SIGMA) * delta);
      R_s *= 1.0 + ((2.0 / PI) * atan(1.40 * pow((this.GetParameter(TCP.ROUGH) / delta), 2.0)));
      const Q_c_e = (PI * Z0_h_e * W * F) / (R_s * C0 * K);
      alpha_c_e = (20.0 * PI / log(10.0)) * F * sqrt(e_r_eff_e_0) / (C0 * Q_c_e);
      const Q_c_o = (PI * Z0_h_o * W * F) / (R_s * C0 * K);
      alpha_c_o = (20.0 * PI / log(10.0)) * F * sqrt(e_r_eff_o_0) / (C0 * Q_c_o);
    } else alpha_c_e = alpha_c_o = 0.0;
    this.atten_cond_e = alpha_c_e * this.GetParameter(TCP.PHYS_LEN);
    this.atten_cond_o = alpha_c_o * this.GetParameter(TCP.PHYS_LEN);
  }
  private dielectric_losses(): void {
    const e_r = this.GetParameter(TCP.EPSILONR), e_r_eff_e_0 = this.er_eff_e_0, e_r_eff_o_0 = this.er_eff_o_0;
    const F = this.GetParameter(TCP.FREQUENCY), TAND = this.GetParameter(TCP.TAND);
    const alpha_d_e = (20.0 * PI / log(10.0)) * (F / C0) * (e_r / sqrt(e_r_eff_e_0)) * ((e_r_eff_e_0 - 1.0) / (e_r - 1.0)) * TAND;
    const alpha_d_o = (20.0 * PI / log(10.0)) * (F / C0) * (e_r / sqrt(e_r_eff_o_0)) * ((e_r_eff_o_0 - 1.0) / (e_r - 1.0)) * TAND;
    this.atten_dielectric_e = alpha_d_e * this.GetParameter(TCP.PHYS_LEN);
    this.atten_dielectric_o = alpha_d_o * this.GetParameter(TCP.PHYS_LEN);
  }
  private attenuation(): void { this.SetParameter(TCP.SKIN_DEPTH, this.SkinDepth()); this.conductor_losses(); this.dielectric_losses(); }
  private line_angle(): void {
    const v_e = C0 / sqrt(this.er_eff_e), v_o = C0 / sqrt(this.er_eff_o);
    const lambda_g_e = v_e / this.GetParameter(TCP.FREQUENCY), lambda_g_o = v_o / this.GetParameter(TCP.FREQUENCY);
    this.ang_l_e = 2.0 * PI * this.GetParameter(TCP.PHYS_LEN) / lambda_g_e;
    this.ang_l_o = 2.0 * PI * this.GetParameter(TCP.PHYS_LEN) / lambda_g_o;
  }
  private diff_impedance(): void { this.Zdiff = 2.0 * this.GetParameter(TCP.Z0_O); }
  private Z0_dispersion(): void {
    const e_r = this.GetParameter(TCP.EPSILONR), H = this.GetParameter(TCP.H);
    const u = this.GetParameter(TCP.PHYS_WIDTH) / H, g = this.GetParameter(TCP.PHYS_S) / H;
    const f_n = this.GetParameter(TCP.FREQUENCY) * H / 1e06;
    const e_r_eff_single_f = this.m_aux_microstrip.GetParameter(TCP.EPSILON_EFF), e_r_eff_single_0 = this.m_aux_microstrip.er_eff_0, Z0_single_f = this.m_aux_microstrip.GetParameter(TCP.Z0);
    const e_r_eff_o_f = this.er_eff_o, e_r_eff_o_0 = this.er_eff_o_0;
    const Q_11 = 0.893 * (1.0 - 0.3 / (1.0 + 0.7 * (e_r - 1.0)));
    const Q_12 = 2.121 * (pow(f_n / 20.0, 4.91) / (1.0 + Q_11 * pow(f_n / 20.0, 4.91))) * exp(-2.87 * g) * pow(g, 0.902);
    const Q_13 = 1.0 + 0.038 * pow(e_r / 8.0, 5.1);
    const Q_14 = 1.0 + 1.203 * pow(e_r / 15.0, 4.0) / (1.0 + pow(e_r / 15.0, 4.0));
    const Q_15 = 1.887 * exp(-1.5 * pow(g, 0.84)) * pow(g, Q_14) / (1.0 + 0.41 * pow(f_n / 15.0, 3.0) * pow(u, 2.0 / Q_13) / (0.125 + pow(u, 1.626 / Q_13)));
    const Q_16 = (1.0 + 9.0 / (1.0 + 0.403 * pow(e_r - 1.0, 2))) * Q_15;
    const Q_17 = 0.394 * (1.0 - exp(-1.47 * pow(u / 7.0, 0.672))) * (1.0 - exp(-4.25 * pow(f_n / 20.0, 1.87)));
    const Q_18 = 0.61 * (1.0 - exp(-2.13 * pow(u / 8.0, 1.593))) / (1.0 + 6.544 * pow(g, 4.17));
    const Q_19 = 0.21 * g * g * g * g / ((1.0 + 0.18 * pow(g, 4.9)) * (1.0 + 0.1 * u * u) * (1.0 + pow(f_n / 24.0, 3.0)));
    const Q_20 = (0.09 + 1.0 / (1.0 + 0.1 * pow(e_r - 1, 2.7))) * Q_19;
    const Q_21 = Math.abs(1.0 - 42.54 * pow(g, 0.133) * exp(-0.812 * g) * pow(u, 2.5) / (1.0 + 0.033 * pow(u, 2.5)));
    const r_e = pow(f_n / 28.843, 12);
    const q_e = 0.016 + pow(0.0514 * e_r * Q_21, 4.524);
    const p_e = 4.766 * exp(-3.228 * pow(u, 0.641));
    const d_e = 5.086 * q_e * (r_e / (0.3838 + 0.386 * q_e)) * (exp(-22.2 * pow(u, 1.92)) / (1.0 + 1.2992 * r_e)) * (pow(e_r - 1.0, 6.0) / (1.0 + 10 * pow(e_r - 1.0, 6.0)));
    const C_e = 1.0 + 1.275 * (1.0 - exp(-0.004625 * p_e * pow(e_r, 1.674) * pow(f_n / 18.365, 2.745))) - Q_12 + Q_16 - Q_17 + Q_18 + Q_20;
    const R_1 = 0.03891 * pow(e_r, 1.4);
    const R_2 = 0.267 * pow(u, 7.0);
    const R_7 = 1.206 - 0.3144 * exp(-R_1) * (1.0 - exp(-R_2));
    const R_10 = 0.00044 * pow(e_r, 2.136) + 0.0184;
    let tmpf = pow(f_n / 19.47, 6.0);
    const R_11 = tmpf / (1.0 + 0.0962 * tmpf);
    const R_12 = 1.0 / (1.0 + 0.00245 * u * u);
    const R_15 = 0.707 * R_10 * pow(f_n / 12.3, 1.097);
    const R_16 = 1.0 + 0.0503 * e_r * e_r * R_11 * (1.0 - exp(-pow(u / 15.0, 6.0)));
    const Q_0 = R_7 * (1.0 - 1.1241 * (R_12 / R_16) * exp(-0.026 * pow(f_n, 1.15656) - R_15));
    this.SetParameter(TCP.Z0_E, this.Z0_e_0 * pow(0.9408 * pow(e_r_eff_single_f, C_e) - 0.9603, Q_0) / pow((0.9408 - d_e) * pow(e_r_eff_single_0, C_e) - 0.9603, Q_0));
    const Q_29 = 15.16 / (1.0 + 0.196 * pow(e_r - 1.0, 2.0));
    tmpf = pow(e_r - 1.0, 3.0);
    const Q_28 = 0.149 * tmpf / (94.5 + 0.038 * tmpf);
    tmpf = pow(e_r - 1.0, 1.5);
    const Q_27 = 0.4 * pow(g, 0.84) * (1.0 + 2.5 * tmpf / (5.0 + tmpf));
    tmpf = pow((e_r - 1.0) / 13.0, 12.0);
    const Q_26 = 30.0 - 22.2 * (tmpf / (1.0 + 3.0 * tmpf)) - Q_29;
    tmpf = (e_r - 1.0) * (e_r - 1.0);
    const Q_25 = (0.3 * f_n * f_n / (10.0 + f_n * f_n)) * (1.0 + 2.333 * tmpf / (5.0 + tmpf));
    const Q_24 = 2.506 * Q_28 * pow(u, 0.894) * pow((1.0 + 1.3 * u) * f_n / 99.25, 4.29) / (3.575 + pow(u, 0.894));
    const Q_23 = 1.0 + 0.005 * f_n * Q_27 / ((1.0 + 0.812 * pow(f_n / 15.0, 1.9)) * (1.0 + 0.025 * u * u));
    const Q_22 = 0.925 * pow(f_n / Q_26, 1.536) / (1.0 + 0.3 * pow(f_n / 30.0, 1.536));
    this.SetParameter(TCP.Z0_O, Z0_single_f + (this.Z0_o_0 * pow(e_r_eff_o_f / e_r_eff_o_0, Q_22) - Z0_single_f * Q_23) / (1.0 + Q_24 + pow(0.46 * g, 2.2) * Q_25));
  }
  private syn_err_fun(s_h: number, w_h: number, e_r: number, w_h_se: number, w_h_so: number): [number, number] {
    const g = cosh(0.5 * PI * s_h), he = cosh(PI * w_h + 0.5 * PI * s_h);
    let f1 = (2.0 / PI) * Math.acosh((2.0 * he - g + 1.0) / (g + 1.0));
    let f2 = (2.0 / PI) * Math.acosh((2.0 * he - g - 1.0) / (g - 1.0));
    if (e_r <= 6.0) f2 += (4.0 / (PI * (1.0 + e_r / 2.0))) * Math.acosh(1.0 + 2.0 * w_h / s_h);
    else f2 += (1.0 / PI) * Math.acosh(1.0 + 2.0 * w_h / s_h);
    f1 -= w_h_se; f2 -= w_h_so;
    return [f1, f2];
  }
  private synth_width(): void {
    const eps = 1e-04, e_r = this.GetParameter(TCP.EPSILONR);
    let Z0 = this.GetParameter(TCP.Z0_E) / 2.0;
    let a = exp(Z0 * sqrt(e_r + 1.0) / 42.4) - 1.0;
    const w_h_se = 8.0 * sqrt(a * ((7.0 + 4.0 / e_r) / 11.0) + ((1.0 + 1.0 / e_r) / 0.81)) / a;
    Z0 = this.GetParameter(TCP.Z0_O) / 2.0;
    a = exp(Z0 * sqrt(e_r + 1.0) / 42.4) - 1.0;
    const w_h_so = 8.0 * sqrt(a * ((7.0 + 4.0 / e_r) / 11.0) + ((1.0 + 1.0 / e_r) / 0.81)) / a;
    const ce = cosh(0.5 * PI * w_h_se), co = cosh(0.5 * PI * w_h_so);
    let s_h = (2.0 / PI) * Math.acosh((ce + co - 2.0) / (co - ce));
    let w_h = Math.acosh((ce * co - 1.0) / (co - ce)) / PI - s_h / 2.0;
    this.SetParameter(TCP.PHYS_S, s_h * this.GetParameter(TCP.H));
    this.SetParameter(TCP.PHYS_WIDTH, w_h * this.GetParameter(TCP.H));
    let [f1, f2] = this.syn_err_fun(s_h, w_h, e_r, w_h_se, w_h_so);
    let err: number;
    do {
      let [ft1, ft2] = this.syn_err_fun(s_h + eps, w_h, e_r, w_h_se, w_h_so);
      const j11 = (ft1 - f1) / eps, j21 = (ft2 - f2) / eps;
      [ft1, ft2] = this.syn_err_fun(s_h, w_h + eps, e_r, w_h_se, w_h_so);
      const j12 = (ft1 - f1) / eps, j22 = (ft2 - f2) / eps;
      const d_s_h = (-f1 * j22 + f2 * j12) / (j11 * j22 - j21 * j12);
      const d_w_h = (-f2 * j11 + f1 * j21) / (j11 * j22 - j21 * j12);
      s_h += d_s_h; w_h += d_w_h;
      [f1, f2] = this.syn_err_fun(s_h, w_h, e_r, w_h_se, w_h_so);
      err = sqrt(f1 * f1 + f2 * f2);
    } while (err > 1e-04);
    this.SetParameter(TCP.PHYS_S, s_h * this.GetParameter(TCP.H));
    this.SetParameter(TCP.PHYS_WIDTH, w_h * this.GetParameter(TCP.H));
  }
  private syn_fun(s_h: number, w_h: number, Z0_e: number, Z0_o: number): [number, number] {
    this.SetParameter(TCP.PHYS_S, s_h * this.GetParameter(TCP.H));
    this.SetParameter(TCP.PHYS_WIDTH, w_h * this.GetParameter(TCP.H));
    this.Analyse();
    return [this.GetParameter(TCP.Z0_E) - Z0_e, this.GetParameter(TCP.Z0_O) - Z0_o];
  }
}

// ---------------------------------------------------------------- COUPLED_STRIPLINE
const coth = TRANSLINE_CALCULATION_BASE.coth, sech = TRANSLINE_CALCULATION_BASE.sech;
export class COUPLED_STRIPLINE extends TRANSLINE_CALCULATION_BASE {
  private C_f_0 = 0.0; private C_f_t_h = 0.0; private Z0_w_h_0 = 0.0; private Z0_w_h_t_h = 0.0;
  private Z0_e_w_h_0_s_h = 0.0; private Z0_o_w_h_0_s_h = 0.0;
  private e_eff_e = 0.0; private e_eff_o = 0.0; private ang_l = 0.0; private unit_prop_delay_e = 0.0; private unit_prop_delay_o = 0.0;
  private m_striplineCalc = new STRIPLINE();
  constructor() {
    super([TCP.SKIN_DEPTH, TCP.Z0_E, TCP.Z0_O, TCP.Z_DIFF, TCP.Z_COMM, TCP.COUPLING_K, TCP.PHYS_WIDTH, TCP.FREQUENCY, TCP.PHYS_LEN, TCP.H,
      TCP.PHYS_S, TCP.T, TCP.EPSILONR, TCP.MUR, TCP.MURC, TCP.SIGMA, TCP.TAND, TCP.ROUGH, TCP.ANG_L, TCP.STRIPLINE_A, TCP.ATTEN_COND_EVEN,
      TCP.ATTEN_COND_ODD, TCP.ATTEN_DILECTRIC_EVEN, TCP.ATTEN_DILECTRIC_ODD, TCP.DIELECTRIC_MODEL_SEL, TCP.EPSILONR_SPEC_FREQ]);
  }
  Analyse(): void {
    this.UpdateDielectricModel();
    const f = this.GetParameter(TCP.FREQUENCY), rawEpsR = this.GetParameter(TCP.EPSILONR), rawTanD = this.GetParameter(TCP.TAND);
    this.SetParameter(TCP.EPSILONR, this.GetDispersedEpsilonR(f));
    this.SetParameter(TCP.TAND, this.GetDispersedTanDelta(f));
    this.SetParameter(TCP.SKIN_DEPTH, this.SkinDepth());
    const w = this.GetParameter(TCP.PHYS_WIDTH), t = this.GetParameter(TCP.T), s = this.GetParameter(TCP.PHYS_S), h = this.GetParameter(TCP.H);
    let a = this.GetParameter(TCP.STRIPLINE_A);
    const er = this.GetParameter(TCP.EPSILONR);
    if (a <= 0.0) a = h / 2.0;
    this.calcOffsetZeroThicknessCoupledImpedances(h, a, w, s, t, er);
    if (t === 0.0) {
      this.SetParameter(TCP.Z0_E, this.Z0_e_w_h_0_s_h);
      this.SetParameter(TCP.Z0_O, this.Z0_o_w_h_0_s_h);
    } else if (COUPLED_STRIPLINE.IsCenteredOffset(a, h)) {
      this.calcSingleStripImpedances();
      this.calcFringeCapacitances(h, t, er);
      this.calcZ0EvenMode();
      this.calcZ0OddMode(t, s);
    } else if (!COUPLED_STRIPLINE.isOffsetWithinFiniteThicknessLimits(a, h, t)) {
      this.SetParameter(TCP.Z0_E, NaN);
      this.SetParameter(TCP.Z0_O, NaN);
      this.SetParameter(TCP.Z_DIFF, NaN);
    } else {
      const [z0e_1, z0o_1] = this.calcOffsetVirtualBranch(2.0 * a, w, s, t, er);
      const [z0e_2, z0o_2] = this.calcOffsetVirtualBranch(2.0 * (h - a), w, s, t, er);
      this.SetParameter(TCP.H, h);
      const z0e_image = 2.0 / (1.0 / z0e_1 + 1.0 / z0e_2), z0o_image = 2.0 / (1.0 / z0o_1 + 1.0 / z0o_2);
      const z0e = COUPLED_STRIPLINE.applyOffsetCorrection(z0e_image, a, h, w, t, er);
      const z0o = COUPLED_STRIPLINE.applyOffsetCorrection(z0o_image, a, h, w, t, er);
      this.SetParameter(TCP.Z0_E, z0e);
      this.SetParameter(TCP.Z0_O, z0o);
      this.SetParameter(TCP.Z_DIFF, 2.0 * z0o);
      this.calcOffsetZeroThicknessCoupledImpedances(h, a, w, s, t, er);
    }
    this.calcLosses();
    this.calcDielectrics();
    const z0e = this.GetParameter(TCP.Z0_E), z0o = this.GetParameter(TCP.Z0_O);
    this.SetParameter(TCP.Z_COMM, 0.5 * z0e);
    if ((z0e + z0o) > 0.0) this.SetParameter(TCP.COUPLING_K, (z0e - z0o) / (z0e + z0o));
    else this.SetParameter(TCP.COUPLING_K, 0.0);
    this.SetParameter(TCP.EPSILONR, rawEpsR);
    this.SetParameter(TCP.TAND, rawTanD);
  }
  Synthesize(aOpts: SYNTHESIZE_OPTS): boolean {
    if (aOpts === SYNTHESIZE_OPTS.FROM_ZDIFF_ZCOMM) {
      const zDiffTarget = this.GetParameter(TCP.Z_DIFF), zCommTarget = this.GetParameter(TCP.Z_COMM);
      if (!(zDiffTarget > 0.0) || !(zCommTarget > 0.0)) return false;
      this.SetParameter(TCP.Z0_O, 0.5 * zDiffTarget);
      this.SetParameter(TCP.Z0_E, 2.0 * zCommTarget);
    }
    if (aOpts === SYNTHESIZE_OPTS.FIX_WIDTH) return this.MinimiseZ0Error1D(TCP.PHYS_S, TCP.Z0_O, false);
    if (aOpts === SYNTHESIZE_OPTS.FIX_SPACING) return this.MinimiseZ0Error1D(TCP.PHYS_WIDTH, TCP.Z0_O, false);
    // modified from wcalc (Dan McMahill, GPL version 2)
    let ze0 = 0, zo0 = 0;
    const h = this.GetParameter(TCP.H), er = this.GetParameter(TCP.EPSILONR);
    const z0e_target = this.GetParameter(TCP.Z0_E), z0o_target = this.GetParameter(TCP.Z0_O);
    const z0 = sqrt(z0e_target * z0o_target), k = (z0e_target - z0o_target) / (z0e_target + z0o_target);
    const maxiters = 50;
    const ai = [1, -0.301, 3.209, -27.282, 56.609, -37.746];
    const bi = [0.020, -0.623, 17.192, -68.946, 104.740, -16.148];
    const ci = [0.002, -0.347, 7.171, -36.910, 76.132, -51.616];
    const AW = exp(z0 * sqrt(er + 1.0) / 42.4) - 1.0;
    const F1 = 8.0 * sqrt(AW * (7.0 + 4.0 / er) / 11.0 + (1.0 + 1.0 / er) / 0.81) / AW;
    let F2 = 0.0, F3 = 0.0;
    for (let i = 0; i <= 5; i++) F2 = F2 + ai[i] * pow(k, i);
    for (let i = 0; i <= 5; i++) F3 = F3 + (bi[i] - ci[i] * (9.6 - er)) * pow((0.6 - k), i);
    let w = h * Math.abs(F1 * F2), s = h * Math.abs(F1 * F3);
    let iters = 0, done = false;
    const delta = UNIT_MIL * 1e-5;
    const cval = 1e-12 * z0e_target * z0o_target;
    while (!done && iters < maxiters) {
      iters++;
      this.SetParameter(TCP.PHYS_WIDTH, w); this.SetParameter(TCP.PHYS_S, s); this.Analyse();
      ze0 = this.GetParameter(TCP.Z0_E); zo0 = this.GetParameter(TCP.Z0_O);
      const err = pow((ze0 - z0e_target), 2.0) + pow((zo0 - z0o_target), 2.0);
      if (err < cval) done = true;
      else {
        this.SetParameter(TCP.PHYS_WIDTH, w + delta); this.SetParameter(TCP.PHYS_S, s); this.Analyse();
        const ze1 = this.GetParameter(TCP.Z0_E), zo1 = this.GetParameter(TCP.Z0_O);
        this.SetParameter(TCP.PHYS_WIDTH, w); this.SetParameter(TCP.PHYS_S, s + delta); this.Analyse();
        const ze2 = this.GetParameter(TCP.Z0_E), zo2 = this.GetParameter(TCP.Z0_O);
        const dedw = (ze1 - ze0) / delta, dodw = (zo1 - zo0) / delta, deds = (ze2 - ze0) / delta, dods = (zo2 - zo0) / delta;
        const d = dedw * dods - deds * dodw;
        let dw = -1.0 * ((ze0 - z0e_target) * dods - (zo0 - z0o_target) * deds) / d;
        if (Math.abs(dw) > 0.1 * w) dw = dw > 0.0 ? 0.1 * w : -0.1 * w;
        w = Math.abs(w + dw);
        let ds = ((ze0 - z0e_target) * dodw - (zo0 - z0o_target) * dedw) / d;
        if (Math.abs(ds) > 0.1 * s) ds = ds > 0.0 ? 0.1 * s : -0.1 * s;
        s = Math.abs(s + ds);
      }
    }
    if (!done) return false;
    this.SetParameter(TCP.PHYS_WIDTH, w); this.SetParameter(TCP.PHYS_S, s); this.Analyse();
    this.SetParameter(TCP.Z0_E, z0e_target); this.SetParameter(TCP.Z0_O, z0o_target);
    return true;
  }
  private publishResults(analysis: boolean, aImpedanceFailure: TRANSLINE_STATUS, aGeometryFailure: TRANSLINE_STATUS): void {
    const write = (p: TCP, v: number, s: TRANSLINE_STATUS): void => { if (analysis) this.SetAnalysisResult(p, v, s); else this.SetSynthesisResult(p, v, s); };
    const writeOk = (p: TCP, v: number): void => write(p, v, TRANSLINE_STATUS.OK);
    const writeChecked = (p: TCP, v: number, positive: boolean, fail: TRANSLINE_STATUS): void => {
      const invalid = !isfinite(v) || (positive ? v <= 0.0 : v < 0.0);
      write(p, v, invalid ? fail : TRANSLINE_STATUS.OK);
    };
    writeOk(TCP.EPSILON_EFF_EVEN, this.e_eff_e);
    writeOk(TCP.EPSILON_EFF_ODD, this.e_eff_o);
    writeOk(TCP.UNIT_PROP_DELAY_EVEN, this.unit_prop_delay_e);
    writeOk(TCP.UNIT_PROP_DELAY_ODD, this.unit_prop_delay_o);
    writeOk(TCP.SKIN_DEPTH, this.GetParameter(TCP.SKIN_DEPTH));
    writeOk(TCP.ATTEN_COND_EVEN, this.GetParameter(TCP.ATTEN_COND_EVEN));
    writeOk(TCP.ATTEN_COND_ODD, this.GetParameter(TCP.ATTEN_COND_ODD));
    writeOk(TCP.ATTEN_DILECTRIC_EVEN, this.GetParameter(TCP.ATTEN_DILECTRIC_EVEN));
    writeOk(TCP.ATTEN_DILECTRIC_ODD, this.GetParameter(TCP.ATTEN_DILECTRIC_ODD));
    writeChecked(TCP.Z0_E, this.GetParameter(TCP.Z0_E), true, aImpedanceFailure);
    writeChecked(TCP.Z0_O, this.GetParameter(TCP.Z0_O), true, aImpedanceFailure);
    writeChecked(TCP.Z_DIFF, this.GetParameter(TCP.Z_DIFF), true, aImpedanceFailure);
    writeOk(TCP.Z_COMM, this.GetParameter(TCP.Z_COMM));
    writeOk(TCP.COUPLING_K, this.GetParameter(TCP.COUPLING_K));
    writeChecked(TCP.ANG_L, this.ang_l, false, aImpedanceFailure);
    writeChecked(TCP.PHYS_WIDTH, this.GetParameter(TCP.PHYS_WIDTH), true, aGeometryFailure);
    writeChecked(TCP.PHYS_LEN, this.GetParameter(TCP.PHYS_LEN), false, aGeometryFailure);
    writeChecked(TCP.PHYS_S, this.GetParameter(TCP.PHYS_S), true, aGeometryFailure);
  }
  protected SetAnalysisResults(): void { this.publishResults(true, TRANSLINE_STATUS.TS_ERROR, TRANSLINE_STATUS.WARNING); }
  protected SetSynthesisResults(): void { this.publishResults(false, TRANSLINE_STATUS.WARNING, TRANSLINE_STATUS.TS_ERROR); }
  private calcFringeCapacitances(h: number, t: number, er: number): void {
    this.C_f_t_h = (E0 * er / PI) * ((2.0 / (1.0 - t / h)) * log((1.0 / (1.0 - t / h)) + 1.0) - (1.0 / (1.0 - t / h) - 1.0) * log((1.0 / pow(1.0 - t / h, 2.0)) - 1.0));
    this.C_f_0 = (E0 * er / PI) * 2.0 * log(2.0);
  }
  private calcZeroThicknessCoupledImpedances(h: number, w: number, s: number, er: number): void {
    const k_e = tanh(PI * w / (2.0 * h)) * tanh(PI * (w + s) / (2.0 * h));
    const k_o = tanh(PI * w / (2.0 * h)) * coth(PI * (w + s) / (2.0 * h));
    const k_e_p = sqrt(1 - pow(k_e, 2)), k_o_p = sqrt(1 - pow(k_o, 2));
    this.Z0_e_w_h_0_s_h = (ZF0 / (4.0 * sqrt(er))) * (EllipticIntegral(k_e_p)[0] / EllipticIntegral(k_e)[0]);
    this.Z0_o_w_h_0_s_h = (ZF0 / (4.0 * sqrt(er))) * (EllipticIntegral(k_o_p)[0] / EllipticIntegral(k_o)[0]);
  }
  /** True when the strip plane offset a is effectively at the centre (a = h/2) */
  static IsCenteredOffset(a: number, h: number): boolean { return Math.abs(a - h / 2.0) <= h * 1e-9; }
  private static isOffsetWithinFiniteThicknessLimits(a: number, h: number, t: number): boolean { return (a > 0.5 * t) && (a < h - 0.5 * t); }
  private calcOffsetVirtualBranch(aVirtualH: number, w: number, s: number, t: number, er: number): [number, number] {
    this.SetParameter(TCP.H, aVirtualH);
    this.calcZeroThicknessCoupledImpedances(aVirtualH, w, s, er);
    this.calcSingleStripImpedances();
    this.calcFringeCapacitances(aVirtualH, t, er);
    this.calcZ0EvenMode();
    this.calcZ0OddMode(t, s);
    return [this.GetParameter(TCP.Z0_E), this.GetParameter(TCP.Z0_O)];
  }
  private calcOffsetZeroThicknessCoupledImpedances(h: number, a: number, w: number, s: number, t: number, er: number): void {
    if (COUPLED_STRIPLINE.IsCenteredOffset(a, h)) { this.calcZeroThicknessCoupledImpedances(h, w, s, er); return; }
    this.calcZeroThicknessCoupledImpedances(2.0 * a, w, s, er);
    const z0e_1 = this.Z0_e_w_h_0_s_h, z0o_1 = this.Z0_o_w_h_0_s_h;
    this.calcZeroThicknessCoupledImpedances(2.0 * (h - a), w, s, er);
    const z0e_2 = this.Z0_e_w_h_0_s_h, z0o_2 = this.Z0_o_w_h_0_s_h;
    const z0e_image = 2.0 / (1.0 / z0e_1 + 1.0 / z0e_2), z0o_image = 2.0 / (1.0 / z0o_1 + 1.0 / z0o_2);
    this.Z0_e_w_h_0_s_h = COUPLED_STRIPLINE.applyOffsetCorrection(z0e_image, a, h, w, t, er);
    this.Z0_o_w_h_0_s_h = COUPLED_STRIPLINE.applyOffsetCorrection(z0o_image, a, h, w, t, er);
  }
  private static applyOffsetCorrection(aZImage: number, aOffset: number, aPlateSpacing: number, aWidth: number, aThickness: number, aEr: number): number {
    const position = Math.abs(0.5 - aOffset / aPlateSpacing);
    const positionFactor = pow(position, 2.2);
    const widthFactor = pow((aThickness + aWidth) / aPlateSpacing, 2.9);
    const correction = (0.26 * PI / 8.0) * sqrt(aEr) * aZImage * positionFactor * widthFactor;
    return aZImage * (1.0 - correction);
  }
  private calcSingleStripImpedances(): void {
    const er = this.GetParameter(TCP.EPSILONR), h = this.GetParameter(TCP.H), w = this.GetParameter(TCP.PHYS_WIDTH);
    this.Z0_w_h_t_h = this.calcZ0SymmetricStripline();
    const k = sech(PI * w / (2.0 * h)), k_p = tanh(PI * w / (2.0 * h));
    this.Z0_w_h_0 = (ZF0 / (4.0 * sqrt(er))) * (EllipticIntegral(k)[0] / EllipticIntegral(k_p)[0]);
  }
  private calcZ0EvenMode(): void {
    const Z_e = 1.0 / ((1.0 / this.Z0_w_h_t_h) - (this.C_f_t_h / this.C_f_0) * ((1.0 / this.Z0_w_h_0) - (1.0 / this.Z0_e_w_h_0_s_h)));
    this.SetParameter(TCP.Z0_E, Z_e);
  }
  private calcZ0OddMode(t: number, s: number): void {
    const Z_o_1 = 1.0 / ((1.0 / this.Z0_w_h_t_h) + (this.C_f_t_h / this.C_f_0) * ((1.0 / this.Z0_o_w_h_0_s_h) - (1.0 / this.Z0_w_h_0)));
    const Z_o_2 = 1.0 / ((1.0 / this.Z0_o_w_h_0_s_h) + ((1.0 / this.Z0_w_h_t_h) - (1.0 / this.Z0_w_h_0)) - (2.0 / ZF0) * (this.C_f_t_h / E0 - this.C_f_0 / E0) + (2.0 * t) / (ZF0 * s));
    const Z_o = s / t >= 5.0 ? Z_o_1 : Z_o_2;
    this.SetParameter(TCP.Z0_O, Z_o);
    this.SetParameter(TCP.Z_DIFF, 2.0 * Z_o);
  }
  private calcLosses(): void {
    const length = this.GetParameter(TCP.PHYS_LEN), freq = this.GetParameter(TCP.FREQUENCY), er = this.GetParameter(TCP.EPSILONR), tand = this.GetParameter(TCP.TAND);
    const alpha_d_dB_per_m = LOG2DB * (PI / C0) * freq * sqrt(er) * tand;
    const atten_d = alpha_d_dB_per_m * length;
    this.SetParameter(TCP.ATTEN_DILECTRIC_EVEN, atten_d);
    this.SetParameter(TCP.ATTEN_DILECTRIC_ODD, atten_d);
    const sc = this.m_striplineCalc;
    sc.SetParameter(TCP.EPSILONR, er);
    sc.SetParameter(TCP.T, this.GetParameter(TCP.T));
    sc.SetParameter(TCP.STRIPLINE_A, this.GetParameter(TCP.H) / 2.0);
    sc.SetParameter(TCP.H, this.GetParameter(TCP.H));
    sc.SetParameter(TCP.PHYS_LEN, length);
    sc.SetParameter(TCP.FREQUENCY, freq);
    sc.SetParameter(TCP.TAND, 0.0);
    sc.SetParameter(TCP.PHYS_WIDTH, this.GetParameter(TCP.PHYS_WIDTH));
    sc.SetParameter(TCP.ANG_L, 0.0);
    sc.SetParameter(TCP.SIGMA, this.GetParameter(TCP.SIGMA));
    sc.SetParameter(TCP.MURC, this.GetParameter(TCP.MURC));
    sc.Analyse();
    const loss_single = sc.GetParameter(TCP.LOSS_CONDUCTOR), z0_single = sc.GetParameter(TCP.Z0);
    const z0_e = this.GetParameter(TCP.Z0_E), z0_o = this.GetParameter(TCP.Z0_O);
    let atten_c_e = 0.0, atten_c_o = 0.0;
    if (z0_e > 0.0 && isfinite(z0_e)) atten_c_e = loss_single * (z0_single / z0_e);
    if (z0_o > 0.0 && isfinite(z0_o)) atten_c_o = loss_single * (z0_single / z0_o);
    this.SetParameter(TCP.ATTEN_COND_EVEN, atten_c_e);
    this.SetParameter(TCP.ATTEN_COND_ODD, atten_c_o);
  }
  private calcDielectrics(): void {
    const e_r = this.GetParameter(TCP.EPSILONR);
    this.e_eff_e = e_r; this.e_eff_o = e_r;
    const unitPropDelay = UnitPropagationDelay(e_r);
    this.unit_prop_delay_e = unitPropDelay; this.unit_prop_delay_o = unitPropDelay;
    const v = C0 / sqrt(e_r), lambda_g = v / this.GetParameter(TCP.FREQUENCY);
    this.ang_l = 2.0 * PI * this.GetParameter(TCP.PHYS_LEN) / lambda_g;
  }
  private calcZ0SymmetricStripline(): number {
    const sc = this.m_striplineCalc;
    sc.SetParameter(TCP.EPSILONR, this.GetParameter(TCP.EPSILONR));
    sc.SetParameter(TCP.T, this.GetParameter(TCP.T));
    sc.SetParameter(TCP.STRIPLINE_A, this.GetParameter(TCP.H) / 2.0);
    sc.SetParameter(TCP.H, this.GetParameter(TCP.H));
    sc.SetParameter(TCP.PHYS_LEN, this.GetParameter(TCP.PHYS_LEN));
    sc.SetParameter(TCP.FREQUENCY, this.GetParameter(TCP.FREQUENCY));
    sc.SetParameter(TCP.TAND, 0.0);
    sc.SetParameter(TCP.PHYS_WIDTH, this.GetParameter(TCP.PHYS_WIDTH));
    sc.SetParameter(TCP.ANG_L, 0);
    sc.SetParameter(TCP.SIGMA, this.GetParameter(TCP.SIGMA));
    sc.SetParameter(TCP.MURC, this.GetParameter(TCP.MURC));
    sc.Analyse();
    return sc.GetParameter(TCP.Z0);
  }
}
