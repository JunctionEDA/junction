// pcbdialogs/tuning-profile-calc — the calculator behind the Track Width, Diff Pair Gap and Unit Delay cells of
// Board Setup > Design Rules > Tuning Profiles (PANEL_SETUP_TUNING_PROFILE_INFO::calculateTrackParametersForCell and
// its calculateSingleMicrostrip / calculateSingleStripline / calculateDifferentialMicrostrip /
// calculateDifferentialStripline, getMicrostripBoardParameters / getStriplineBoardParameters,
// calculateAverageDielectricConstants, getSolderMaskParameters), over BOARD::GetStackupOrDefault.
// Pure: the page hands it the row, the profile's fields and the board stackup, and shows what comes back.
import type { StackupLayer } from "../../canvas/board-setup";
import { COUPLED_MICROSTRIP, COUPLED_STRIPLINE, DIELECTRIC_DJORDJEVIC_SARKAR, MICROSTRIP, MU0, STRIPLINE, SYNTHESIZE_OPTS, TCP, TRANSLINE_STATUS, resultOf, type TranslineResults } from "../../calculator/transline";

/** BOARD_STACKUP_ITEM_TYPE */
export type StackupItemType = "copper" | "dielectric" | "solderpaste" | "soldermask" | "silkscreen";
/** One DIELECTRIC_PRMS of a stackup item (thickness in IU, nm). */
export interface StackupSubPrms { thickness: number; epsilonR: number; lossTangent: number; specFreq: number; model: "constant" | "djordjevic_sarkar" }
/** BOARD_STACKUP_ITEM as the calculator reads it: its type, board layer (canonical name, null for a dielectric) and sub-layers. */
export interface StackupItem { type: StackupItemType; layer: string | null; subs: StackupSubPrms[] }

const IU_PER_MM = 1e6;
const toIU = (mm: number): number => Math.round(mm * IU_PER_MM);
const IUTomm = (iu: number): number => iu / IU_PER_MM;
/** DEFAULT_EPSILON_R_SOLDERMASK, DEFAULT_EPSILON_R_SILKSCREEN */
const EPS_MASK = 3.3, EPS_SILK = 1.0;
/** BOARD_STACKUP_ITEM::GetCopperDefaultThickness / GetMaskDefaultThickness (IU) */
const COPPER_DEFAULT = toIU(0.035), MASK_DEFAULT = toIU(0.01);

/** BOARD_STACKUP_ITEM( type ): the main DIELECTRIC_PRMS a new item starts with. */
function defaultPrms(type: StackupItemType): StackupSubPrms {
  const p: StackupSubPrms = { thickness: 0, epsilonR: 1.0, lossTangent: 0.0, specFreq: 0.0, model: "constant" };
  if (type === "copper") p.thickness = COPPER_DEFAULT;
  else if (type === "dielectric") { p.lossTangent = 0.02; p.epsilonR = 4.5; p.specFreq = 1e9; }
  else if (type === "soldermask") { p.thickness = MASK_DEFAULT; p.epsilonR = EPS_MASK; }
  else if (type === "silkscreen") p.epsilonR = EPS_SILK;
  return p;
}
/** PCB_IO_KICAD_SEXPR_PARSER::parseBoardStackup's item type from the layer name (null: not a stackup item). */
function itemType(name: string): StackupItemType | null {
  if (name === "F.SilkS" || name === "B.SilkS") return "silkscreen";
  if (name === "F.Mask" || name === "B.Mask") return "soldermask";
  if (name === "F.Paste" || name === "B.Paste") return "solderpaste";
  if (/^(F|B|In\d+)\.Cu$/.test(name)) return "copper";
  if (/\.(Adhes|CrtYd|Fab|User|Cuts)$|^(Margin|User\.\d+)$/.test(name)) return null;
  return "dielectric";
}
/** The board's (stackup …) as BOARD_STACKUP items, with the parser's defaults for what the file leaves out. */
export function stackupFromLayers(layers: StackupLayer[]): StackupItem[] {
  const out: StackupItem[] = [];
  for (const l of layers) {
    const type = itemType(l.name); if (!type) continue;
    const main = defaultPrms(type);
    if (l.thickness !== undefined) main.thickness = toIU(l.thickness);
    if (l.epsilonR !== undefined) main.epsilonR = l.epsilonR;
    if (l.lossTangent !== undefined) main.lossTangent = l.lossTangent;
    if (type === "dielectric") { if (l.specFreq !== undefined) main.specFreq = l.specFreq; main.model = l.dielectricModel || "constant"; }
    const subs: StackupSubPrms[] = [main];
    for (const s of l.subs || []) subs.push({ thickness: toIU(s.thickness), epsilonR: s.epsilonR, lossTangent: s.lossTangent, specFreq: s.specFreq !== undefined ? s.specFreq : 0.0, model: s.dielectricModel || "constant" });
    out.push({ type, layer: type === "dielectric" ? null : l.name, subs });
  }
  return out;
}
/** The copper layers in stack order (LSET::CuStack): F.Cu, In1.Cu … In(n-2).Cu, B.Cu. */
export function copperStackNames(count: number): string[] { const out = ["F.Cu"]; for (let i = 1; i <= count - 2; i++) out.push(`In${i}.Cu`); out.push("B.Cu"); return out; }
/**
 * BOARD_STACKUP::BuildDefaultStackupList for a board without a (stackup …): silk, paste and mask on top when
 * enabled, copper and FR4 dielectrics (core, prepreg …) splitting what the copper and masks leave of the board
 * thickness, then the bottom mask, paste and silk.
 */
export function defaultStackup(enabledLayers: string[], copperCount: number, boardThicknessMm: number): StackupItem[] {
  const on = new Set(enabledLayers), out: StackupItem[] = [];
  const add = (type: StackupItemType, layer: string | null, thickness?: number): void => { const p = defaultPrms(type); if (thickness !== undefined) p.thickness = thickness; out.push({ type, layer, subs: [p] }); };
  let diel = toIU(boardThicknessMm) - COPPER_DEFAULT * copperCount;
  const sm = (on.has("F.Mask") ? 1 : 0) + (on.has("B.Mask") ? 1 : 0);
  diel -= MASK_DEFAULT * sm;
  diel = Math.trunc(diel / Math.max(1, copperCount - 1));
  if (on.has("F.SilkS")) add("silkscreen", "F.SilkS");
  if (on.has("F.Paste")) add("solderpaste", "F.Paste");
  if (on.has("F.Mask")) add("soldermask", "F.Mask");
  for (const cu of copperStackNames(copperCount)) {
    add("copper", cu);
    if (cu === "B.Cu") break;
    add("dielectric", null, diel);
  }
  if (on.has("B.Mask")) add("soldermask", "B.Mask");
  if (on.has("B.Paste")) add("solderpaste", "B.Paste");
  if (on.has("B.SilkS")) add("silkscreen", "B.SilkS");
  return out;
}

/** PCB_LAYER_ID of a copper layer: F_Cu 0, B_Cu 2, In1_Cu 4 … */
const cuId = (name: string): number => (name === "F.Cu" ? 0 : name === "B.Cu" ? 2 : 2 * (Number((/^In(\d+)\.Cu$/.exec(name) || [])[1] || 0) + 1));
/** IsCopperLayerLowerThan */
export function isCopperLayerLowerThan(a: string, b: string): boolean {
  const la = cuId(a), lb = cuId(b);
  if (la === lb) return false;
  if (la === 2) return true;
  if (lb === 2) return false;
  return la > lb;
}

/** The row of the Track Propagation grid: layers by canonical name ("" for <None>), width and gap in mm (NaN when empty). */
export interface TrackRow { signal: string; top: string; bottom: string; width: number; gap: number }
export interface ProfileInputs {
  /** m_type: 0 single, 1 differential */
  type: number;
  /** m_targetImpedance's value (NaN when the text is not a number: getTargetImpedance's -1) */
  targetImpedance: number;
  /** getFrequency(), Hz */
  frequency: number;
  modelSolderMask: boolean;
  /** PANEL_SETUP_TUNING_PROFILES::m_layerNames: the copper layers in stack order */
  layerNames: string[];
  /** BOARD::GetStackupOrDefault().GetList() */
  stackup: StackupItem[];
}
export type CalculationType = "width" | "gap" | "delay";
/** What a calculation leaves: an error to show (DisplayErrorMessage), or the cells to set (IU: nm, as/mm). */
export type CellCalculation = { error: string } | { width?: number; gap?: number; delay: number };

interface CalcResult { OK: boolean; Width: number; DiffPairGap: number; Delay: number; ErrorMsg: string }
const failed = (msg: string): CalcResult => ({ OK: false, Width: 0, DiffPairGap: 0, Delay: 0, ErrorMsg: msg });
interface BoardParameters { SignalLayer: string; DielectricConstant: number; TopDielectricLayerThickness: number; BottomDielectricLayerThickness: number; SignalLayerThickness: number; LossTangent: number; SolderMaskDielectricConstant: number; SolderMaskThickness: number; SolderMaskLossTangent: number }
interface DielectricInfo { Height: number; E_r: number; Loss_Tangent: number }

/** PANEL_SETUP_TUNING_PROFILE_INFO::RHO (copper resistivity) */
export const RHO = 1.72e-8;
/** EDA_UNIT_UTILS::UI::FromUserUnit( MM ) truncated to int (static_cast<int>) */
const mmToIUInt = (mm: number): number => Math.trunc(mm * IU_PER_MM);
/** FromUserUnit( PS_PER_CM ) truncated to int: PS_PER_MM_TO_IU( v / 10 ) */
const psPerCmToIUInt = (v: number): number => Math.trunc(v / 10 * 1e6);

/**
 * PANEL_SETUP_TUNING_PROFILE_INFO's calculators.  One per profile page, like the panel's m_microstripCalc,
 * m_striplineCalc, m_coupledMicrostripCalc and m_coupledStriplineCalc members, so parameters set by one
 * calculation stay for the next as they do in KiCad.
 */
export class TuningProfileCalculator {
  readonly microstrip = new MICROSTRIP();
  readonly stripline = new STRIPLINE();
  readonly coupledMicrostrip = new COUPLED_MICROSTRIP();
  readonly coupledStripline = new COUPLED_STRIPLINE();

  static calculateSkinDepth(aFreq: number, aMurc: number, aSigma: number): number { return 1.0 / Math.sqrt(Math.PI * aFreq * aMurc * MU0 * aSigma); }
  static getStackupLayerId(list: StackupItem[], layer: string): number { const i = list.findIndex((it) => it.type !== "dielectric" && it.layer === layer); return i; }
  static getDielectricLayers(list: StackupItem[], aSignalLayerId: number, aReferenceLayerId: number, out: number[]): void {
    for (let i = Math.min(aSignalLayerId, aReferenceLayerId) + 1; i < Math.max(aSignalLayerId, aReferenceLayerId); ++i) {
      const layer = list[i];
      if (layer.type !== "dielectric") continue;
      // HasEpsilonRValue: dielectric or solder mask
      out.push(i);
    }
  }
  static calculateAverageDielectricConstants(list: StackupItem[], ids: number[], targetFreq: number): DielectricInfo {
    let totalHeight = 0.0, e_r = 0.0, lossTangent = 0.0;
    for (const i of ids) {
      const layer = list[i];
      for (const sub of layer.subs) {
        totalHeight += IUTomm(sub.thickness);
        let e_r_layer = sub.epsilonR, l_t_layer = sub.lossTangent;
        const spec_freq = sub.specFreq;
        if (sub.model === "djordjevic_sarkar" && Number.isFinite(spec_freq) && spec_freq > 0.0) {
          try { const ds = new DIELECTRIC_DJORDJEVIC_SARKAR(); ds.Fit(e_r_layer, l_t_layer, spec_freq); e_r_layer = ds.EpsilonRealAt(targetFreq); l_t_layer = ds.TanDeltaAt(targetFreq); } catch { /* ignore */ }
        }
        e_r += e_r_layer * IUTomm(sub.thickness);
        lossTangent += l_t_layer * IUTomm(sub.thickness);
      }
    }
    if (totalHeight <= 0.0) return { Height: 0.0, E_r: 0.0, Loss_Tangent: 0.0 };
    e_r = e_r / totalHeight; lossTangent = lossTangent / totalHeight; totalHeight /= 1000.0;
    return { Height: totalHeight, E_r: e_r, Loss_Tangent: lossTangent };
  }
  static getSolderMaskParameters(list: StackupItem[], signal: string): DielectricInfo {
    const mask = signal === "F.Cu" ? "F.Mask" : signal === "B.Cu" ? "B.Mask" : null;
    if (!mask) return { Height: 0.0, E_r: 0.0, Loss_Tangent: 0.0 };
    const idx = TuningProfileCalculator.getStackupLayerId(list, mask);
    if (idx < 0) return { Height: 0.0, E_r: 0.0, Loss_Tangent: 0.0 };
    const p = list[idx].subs[0];
    return { Height: IUTomm(p.thickness) / 1000.0, E_r: p.epsilonR, Loss_Tangent: p.lossTangent };
  }

  private microstripBoardParameters(row: TrackRow, inp: ProfileInputs): [BoardParameters | null, CalcResult] {
    const list = inp.stackup, names = inp.layerNames;
    if (!names.includes(row.signal)) return [null, failed("Signal layer not found in stackup")];
    const signalLayer = row.signal;
    if (signalLayer !== "F.Cu" && signalLayer !== "B.Cu") return [null, failed("Internal error: Microstrip can only be on an outer copper layer")];
    const signalId = TuningProfileCalculator.getStackupLayerId(list, signalLayer);
    if (signalId === -1) return [null, failed("Signal layer not found in stackup")];
    const signalThickness = IUTomm(list[signalId].subs[0].thickness) / 1000.0;
    if (signalThickness <= 0) return [null, failed("Signal layer thickness must be greater than 0")];
    const referenceName = signalLayer === "F.Cu" ? row.bottom : row.top;
    if (!names.includes(referenceName)) return [null, failed("Reference layer not found in stackup")];
    const referenceId = TuningProfileCalculator.getStackupLayerId(list, referenceName);
    if (signalId === referenceId) return [null, failed("Reference layer must be different to signal layer")];
    const ids: number[] = [];
    TuningProfileCalculator.getDielectricLayers(list, signalId, referenceId, ids);
    const diel = TuningProfileCalculator.calculateAverageDielectricConstants(list, ids, inp.frequency);
    if (diel.Height <= 0.0) return [null, failed("Dielectric height must be greater than 0")];
    const mask = TuningProfileCalculator.getSolderMaskParameters(list, signalLayer);
    return [{ SignalLayer: signalLayer, DielectricConstant: diel.E_r, TopDielectricLayerThickness: diel.Height, BottomDielectricLayerThickness: 0.0, SignalLayerThickness: signalThickness,
      LossTangent: diel.Loss_Tangent, SolderMaskDielectricConstant: mask.E_r, SolderMaskThickness: mask.Height, SolderMaskLossTangent: mask.Loss_Tangent }, { OK: true, Width: 0, DiffPairGap: 0, Delay: 0, ErrorMsg: "" }];
  }
  private striplineBoardParameters(row: TrackRow, inp: ProfileInputs): [BoardParameters | null, CalcResult] {
    const list = inp.stackup, names = inp.layerNames;
    if (!names.includes(row.signal)) return [null, failed("Signal layer not found in stackup")];
    const signalLayer = row.signal;
    const signalId = TuningProfileCalculator.getStackupLayerId(list, signalLayer);
    if (signalId === -1) return [null, failed("Signal layer not found in stackup")];
    const signalThickness = IUTomm(list[signalId].subs[0].thickness) / 1000.0;
    if (signalThickness <= 0) return [null, failed("Signal layer thickness must be greater than 0")];
    if (!names.includes(row.top)) return [null, failed("Top reference layer not found in stackup")];
    const topId = TuningProfileCalculator.getStackupLayerId(list, row.top);
    if (!isCopperLayerLowerThan(signalLayer, row.top)) return [null, failed("Top reference layer must be above signal layer in board stackup")];
    if (!names.includes(row.bottom)) return [null, failed("Bottom reference layer not found in stackup")];
    const bottomId = TuningProfileCalculator.getStackupLayerId(list, row.bottom);
    if (!isCopperLayerLowerThan(row.bottom, signalLayer)) return [null, failed("Bottom reference layer must be below signal layer in board stackup")];
    const topIds: number[] = [], bottomIds: number[] = [];
    TuningProfileCalculator.getDielectricLayers(list, signalId, topId, topIds);
    TuningProfileCalculator.getDielectricLayers(list, signalId, bottomId, bottomIds);
    const allIds = [...topIds, ...bottomIds];
    const top = TuningProfileCalculator.calculateAverageDielectricConstants(list, topIds, inp.frequency);
    const bottom = TuningProfileCalculator.calculateAverageDielectricConstants(list, bottomIds, inp.frequency);
    const all = TuningProfileCalculator.calculateAverageDielectricConstants(list, allIds, inp.frequency);
    if (top.Height <= 0.0 && bottom.Height <= 0.0) return [null, failed("Dielectric heights must be greater than 0")];
    return [{ SignalLayer: signalLayer, DielectricConstant: all.E_r, TopDielectricLayerThickness: top.Height, BottomDielectricLayerThickness: bottom.Height, SignalLayerThickness: signalThickness,
      LossTangent: all.Loss_Tangent, SolderMaskDielectricConstant: 0, SolderMaskThickness: 0, SolderMaskLossTangent: 0 }, { OK: true, Width: 0, DiffPairGap: 0, Delay: 0, ErrorMsg: "" }];
  }
  /** getTargetImpedance: the field's number, -1 when it does not parse */
  private static targetZ(inp: ProfileInputs): number { return Number.isFinite(inp.targetImpedance) ? inp.targetImpedance : -1; }
  /** GetUnitValue: the cell in IU, 0 when empty */
  private static unitValue(mm: number): number { return Number.isFinite(mm) ? toIU(mm) : 0; }
  /** GetOptionalUnitValue: the cell in IU, null when empty */
  private static optUnitValue(mm: number): number | null { return Number.isFinite(mm) ? toIU(mm) : null; }

  calculateSingleMicrostrip(row: TrackRow, type: CalculationType, inp: ProfileInputs): CalcResult {
    const targetZ = TuningProfileCalculator.targetZ(inp);
    if (targetZ <= 0) return failed("Target impedance must be greater than 0");
    const [bp, result] = this.microstripBoardParameters(row, inp);
    if (!result.OK || !bp) return result;
    const c = this.microstrip;
    if (type === "width") c.SetParameter(TCP.PHYS_WIDTH, 0.001);
    else if (type === "delay") c.SetParameter(TCP.PHYS_WIDTH, IUTomm(TuningProfileCalculator.unitValue(row.width)) / 1000.0);
    const frequency = inp.frequency;
    c.SetParameter(TCP.SIGMA, 1.0 / RHO);
    c.SetParameter(TCP.EPSILON_EFF, 1.0);
    c.SetParameter(TCP.SKIN_DEPTH, TuningProfileCalculator.calculateSkinDepth(frequency, 1.0, 1.0 / RHO));
    c.SetParameter(TCP.EPSILONR, bp.DielectricConstant);
    c.SetParameter(TCP.H_T, 1e+20);
    c.SetParameter(TCP.H, bp.TopDielectricLayerThickness);
    c.SetParameter(TCP.T, bp.SignalLayerThickness);
    c.SetParameter(TCP.Z0, targetZ);
    c.SetParameter(TCP.FREQUENCY, frequency);
    c.SetParameter(TCP.ROUGH, 0);
    c.SetParameter(TCP.TAND, bp.LossTangent);
    c.SetParameter(TCP.PHYS_LEN, 10);
    c.SetParameter(TCP.MUR, 1);
    c.SetParameter(TCP.MURC, 1);
    c.SetParameter(TCP.ANG_L, 1);
    if (inp.modelSolderMask) {
      c.SetParameter(TCP.SOLDERMASK_PRESENT, 1.0);
      c.SetParameter(TCP.SOLDERMASK_THICKNESS, bp.SolderMaskThickness);
      c.SetParameter(TCP.SOLDERMASK_EPSILONR, bp.SolderMaskDielectricConstant);
      c.SetParameter(TCP.SOLDERMASK_TAND, bp.SolderMaskLossTangent);
    }
    if (type === "width") c.Synthesize(SYNTHESIZE_OPTS.DEFAULT); else c.Analyse();
    const results = type === "width" ? c.GetSynthesisResults() : c.GetAnalysisResults();
    return TuningProfileCalculator.singleResult(results);
  }
  calculateSingleStripline(row: TrackRow, type: CalculationType, inp: ProfileInputs): CalcResult {
    const targetZ = TuningProfileCalculator.targetZ(inp);
    if (targetZ <= 0) return failed("Target impedance must be greater than 0");
    const [bp, result] = this.striplineBoardParameters(row, inp);
    if (!result.OK || !bp) return result;
    const c = this.stripline;
    if (type === "width") c.SetParameter(TCP.PHYS_WIDTH, 0.001);
    else if (type === "delay") c.SetParameter(TCP.PHYS_WIDTH, IUTomm(TuningProfileCalculator.unitValue(row.width)) / 1000.0);
    c.SetParameter(TCP.SKIN_DEPTH, TuningProfileCalculator.calculateSkinDepth(1.0, 1.0, 1.0 / RHO));
    c.SetParameter(TCP.EPSILONR, bp.DielectricConstant);
    c.SetParameter(TCP.T, bp.SignalLayerThickness);
    c.SetParameter(TCP.STRIPLINE_A, bp.TopDielectricLayerThickness);
    c.SetParameter(TCP.H, bp.TopDielectricLayerThickness + bp.SignalLayerThickness + bp.BottomDielectricLayerThickness);
    c.SetParameter(TCP.Z0, targetZ);
    c.SetParameter(TCP.PHYS_LEN, 1.0);
    c.SetParameter(TCP.FREQUENCY, inp.frequency);
    c.SetParameter(TCP.TAND, bp.LossTangent);
    c.SetParameter(TCP.ANG_L, 1.0);
    c.SetParameter(TCP.SIGMA, 1.0 / RHO);
    c.SetParameter(TCP.MURC, 1);
    if (type === "width") c.Synthesize(SYNTHESIZE_OPTS.DEFAULT); else c.Analyse();
    const results = type === "width" ? c.GetSynthesisResults() : c.GetAnalysisResults();
    return TuningProfileCalculator.singleResult(results);
  }
  private static singleResult(results: TranslineResults): CalcResult {
    if (resultOf(results, TCP.PHYS_WIDTH)[1] !== TRANSLINE_STATUS.OK) return failed("Width calculation failed");
    if (resultOf(results, TCP.UNIT_PROP_DELAY)[1] !== TRANSLINE_STATUS.OK) return failed("Delay calculation failed");
    const width = mmToIUInt(resultOf(results, TCP.PHYS_WIDTH)[0] * 1000.0);
    const propDelay = psPerCmToIUInt(resultOf(results, TCP.UNIT_PROP_DELAY)[0]);
    return { OK: true, Width: width, DiffPairGap: 0, Delay: propDelay, ErrorMsg: "" };
  }
  /** The width and gap a differential calculation starts from, or the error that stops it. */
  private static diffInputs(row: TrackRow, type: CalculationType): { width: number; gap: number } | CalcResult {
    let width = 0.0, gap = 0.0;
    const widthOpt = TuningProfileCalculator.optUnitValue(row.width), gapOpt = TuningProfileCalculator.optUnitValue(row.gap);
    if (type === "width") {
      if (gapOpt === null || gapOpt <= 0) return failed("Diff pair gap must be greater than 0 to calculate width");
      gap = IUTomm(gapOpt) / 1000.0;
    } else if (type === "gap") {
      if (widthOpt === null || widthOpt <= 0) return failed("Width must be greater than 0 to calculate diff pair gap");
      width = IUTomm(widthOpt) / 1000.0;
    } else {
      if (widthOpt === null || gapOpt === null || widthOpt <= 0 || gapOpt <= 0) return failed("Width and diff pair gap must be greater than 0 to calculate delay");
      width = IUTomm(widthOpt) / 1000.0; gap = IUTomm(gapOpt) / 1000.0;
    }
    return { width, gap };
  }
  private static diffResult(results: TranslineResults): CalcResult {
    if (resultOf(results, TCP.PHYS_WIDTH)[1] !== TRANSLINE_STATUS.OK) return failed("Width calculation failed");
    if (resultOf(results, TCP.PHYS_S)[1] !== TRANSLINE_STATUS.OK) return failed("Diff pair gap calculation failed");
    if (resultOf(results, TCP.UNIT_PROP_DELAY_ODD)[1] !== TRANSLINE_STATUS.OK) return failed("Delay calculation failed");
    return { OK: true, Width: mmToIUInt(resultOf(results, TCP.PHYS_WIDTH)[0] * 1000.0), DiffPairGap: mmToIUInt(resultOf(results, TCP.PHYS_S)[0] * 1000.0),
      Delay: psPerCmToIUInt(resultOf(results, TCP.UNIT_PROP_DELAY_ODD)[0]), ErrorMsg: "" };
  }
  calculateDifferentialMicrostrip(row: TrackRow, type: CalculationType, inp: ProfileInputs): CalcResult {
    const targetZ = TuningProfileCalculator.targetZ(inp);
    if (targetZ <= 0) return failed("Target impedance must be greater than 0");
    const [bp, result] = this.microstripBoardParameters(row, inp);
    if (!result.OK || !bp) return result;
    const wg = TuningProfileCalculator.diffInputs(row, type);
    if ("OK" in wg) return wg;
    const c = this.coupledMicrostrip;
    c.SetParameter(TCP.Z0_E, targetZ / 2.0);
    c.SetParameter(TCP.Z0_O, targetZ / 2.0);
    c.SetParameter(TCP.Z_DIFF, targetZ);
    c.SetParameter(TCP.PHYS_WIDTH, wg.width);
    c.SetParameter(TCP.PHYS_S, wg.gap);
    c.SetParameter(TCP.EPSILONR, bp.DielectricConstant);
    c.SetParameter(TCP.PHYS_LEN, 10);
    c.SetParameter(TCP.H, bp.TopDielectricLayerThickness);
    c.SetParameter(TCP.T, bp.SignalLayerThickness);
    c.SetParameter(TCP.H_T, 1e+20);
    c.SetParameter(TCP.FREQUENCY, inp.frequency);
    c.SetParameter(TCP.MURC, 1);
    c.SetParameter(TCP.SKIN_DEPTH, TuningProfileCalculator.calculateSkinDepth(1.0, 1.0, 1.0 / RHO));
    c.SetParameter(TCP.SIGMA, 1.0 / RHO);
    c.SetParameter(TCP.ROUGH, 0);
    c.SetParameter(TCP.TAND, bp.LossTangent);
    c.SetParameter(TCP.ANG_L, 1);
    if (inp.modelSolderMask) {
      c.SetParameter(TCP.SOLDERMASK_PRESENT, 1.0);
      c.SetParameter(TCP.SOLDERMASK_THICKNESS, bp.SolderMaskThickness);
      c.SetParameter(TCP.SOLDERMASK_EPSILONR, bp.SolderMaskDielectricConstant);
      c.SetParameter(TCP.SOLDERMASK_TAND, bp.SolderMaskLossTangent);
    }
    if (type === "width") c.Synthesize(SYNTHESIZE_OPTS.FIX_SPACING);
    else if (type === "gap") c.Synthesize(SYNTHESIZE_OPTS.FIX_WIDTH);
    else c.Analyse();
    return TuningProfileCalculator.diffResult(type === "delay" ? c.GetAnalysisResults() : c.GetSynthesisResults());
  }
  calculateDifferentialStripline(row: TrackRow, type: CalculationType, inp: ProfileInputs): CalcResult {
    const targetZ = TuningProfileCalculator.targetZ(inp);
    if (targetZ <= 0) return failed("Target impedance must be greater than 0");
    const [bp, result] = this.striplineBoardParameters(row, inp);
    if (!result.OK || !bp) return result;
    const wg = TuningProfileCalculator.diffInputs(row, type);
    if ("OK" in wg) return wg;
    const c = this.coupledStripline;
    c.SetParameter(TCP.Z0_E, targetZ / 2.0);
    c.SetParameter(TCP.Z0_O, targetZ / 2.0);
    c.SetParameter(TCP.Z_DIFF, targetZ);
    c.SetParameter(TCP.PHYS_WIDTH, wg.width);
    c.SetParameter(TCP.PHYS_S, wg.gap);
    c.SetParameter(TCP.T, bp.SignalLayerThickness);
    const totalH = bp.TopDielectricLayerThickness + bp.SignalLayerThickness + bp.BottomDielectricLayerThickness;
    // COUPLED_STRIPLINE::Analyse reads STRIPLINE_A as the strip midplane distance from the bottom ground: Top + T/2
    const striplineA = bp.TopDielectricLayerThickness + 0.5 * bp.SignalLayerThickness;
    c.SetParameter(TCP.H, totalH);
    c.SetParameter(TCP.STRIPLINE_A, COUPLED_STRIPLINE.IsCenteredOffset(striplineA, totalH) ? 0.0 : striplineA);
    c.SetParameter(TCP.EPSILONR, bp.DielectricConstant);
    c.SetParameter(TCP.SKIN_DEPTH, TuningProfileCalculator.calculateSkinDepth(1.0, 1.0, 1.0 / RHO));
    c.SetParameter(TCP.PHYS_LEN, 1.0);
    c.SetParameter(TCP.FREQUENCY, inp.frequency);
    c.SetParameter(TCP.ANG_L, 1.0);
    c.SetParameter(TCP.SIGMA, 1.0 / RHO);
    c.SetParameter(TCP.MURC, 1);
    if (type === "width") c.Synthesize(SYNTHESIZE_OPTS.FIX_SPACING);
    else if (type === "gap") c.Synthesize(SYNTHESIZE_OPTS.FIX_WIDTH);
    else c.Analyse();
    return TuningProfileCalculator.diffResult(type === "delay" ? c.GetAnalysisResults() : c.GetSynthesisResults());
  }

  /**
   * calculateTrackParametersForCell: the cell's button.  null when the signal layer is not a copper layer (nothing
   * happens); otherwise the message KiCad shows, or the cells to write — the calculated width (or gap) and the delay.
   */
  calculateTrackParametersForCell(row: TrackRow, col: CalculationType, inp: ProfileInputs): CellCalculation | null {
    if (!inp.layerNames.includes(row.signal)) return null;
    const isMicrostrip = row.signal === "F.Cu" || row.signal === "B.Cu";
    if (inp.type !== 0) {
      const result = isMicrostrip ? this.calculateDifferentialMicrostrip(row, col, inp) : this.calculateDifferentialStripline(row, col, inp);
      if (!result.OK) return { error: `Error: ${result.ErrorMsg}` };
      if (!(result.Width > 0)) return { error: "Could not compute track width" };
      if (!(result.DiffPairGap > 0)) return { error: "Could not compute differential pair gap" };
      if (!(result.Delay > 0)) return { error: "Could not compute track propagation delay" };
      if (col === "width") return { width: result.Width, delay: result.Delay };
      if (col === "gap") return { gap: result.DiffPairGap, delay: result.Delay };
      return { delay: result.Delay };
    }
    const result = isMicrostrip ? this.calculateSingleMicrostrip(row, col, inp) : this.calculateSingleStripline(row, col, inp);
    if (!result.OK) return { error: `Error: ${result.ErrorMsg}` };
    if (!(result.Width > 0)) return { error: "Could not compute track width" };
    if (!(result.Delay > 0)) return { error: "Could not compute track propagation delay" };
    if (col === "width") return { width: result.Width, delay: result.Delay };
    return { delay: result.Delay };
  }
}

/** OnAddTrackRow's layers for a new row: after the last row's signal layer, the next copper layer between its neighbours. */
export function newTrackRowLayers(layerNames: string[], lastSignal: string | null): { signal: string; top: string; bottom: string } {
  const row = { signal: "", top: "", bottom: "" };
  const front = (): void => { if (!layerNames.length) return; row.signal = layerNames[0]; if (layerNames.length > 1) row.bottom = layerNames[1]; };
  if (lastSignal === null) { front(); return row; }
  const i = layerNames.indexOf(lastSignal);
  if (i < 0) return row;
  if (i === layerNames.length - 1) { front(); return row; }
  row.signal = layerNames[i + 1]; row.top = layerNames[i];
  if (i + 2 < layerNames.length) row.bottom = layerNames[i + 2];
  return row;
}
