---
corpusId: his-corp-flow-002
title: "HIS业务流与工作站"
domain:
  id: his
  label: "医院HIS系统代码管理"
profileId: bfo-lite
source:
  name: "核心业务流与模块依赖.md"
  path: "note/sample/医院HIS系统代码管理/02-核心业务流与模块依赖.md"
generator: "Synapse-Corpus/1.0"
generatedAt: "2026-09-18T00:00:00Z"
---

# HIS 业务流与工作站

本篇从代码调用链还原核心业务流。关键证据：`DmsRegistrationService.appRegistration` 的方法注释明确写出挂号的副作用，`BmsFeeService` 的方法签名写出收缴费如何以"挂号 id"为主线驱动收费与退费。

## 挂号业务流（跨 DMS / SMS / PMS / BMS）

`DmsRegistrationService.appRegistration` 注释原文：

```
1. 先根据 skd_id 判断 remain 是否 > 0        // 读 sms_skd 排班号源
2. 若 > 0，绑定医生(skd_id, bind_status=1)，并修改 sms_skd 中的排班限额(-1)   // 写 sms_skd
3. 向 dms_registration 插入信息               // 写 dms_registration
4. 向 bms_bills_record 中插入账单记录         // 写 bms_bills_record
```

据此，挂号一条业务流**串联 4 个模块、读写 4 张表**：

```
患者(PmsPatient) ──选排班(SmsSkd 扣号)──▶ 挂号(DmsRegistration 落单) ──生成账单──▶ 收费(BmsBillsRecord)
```

依赖关系：挂号 依赖 排班(SMS)、患者管理(PMS)、收费(BMS)。

## 收缴费业务流（以挂号 id 为主线）

`BmsFeeService` 方法：

- `listRegisteredPatient` / `listChargeByRegistrationId`：按挂号 id 查未缴费项目 → 收费模块依赖挂号；
- `charge`：收费，写账单/发票；
- `refundCharge`（非药品、药品退费）→ 依赖药品管理与开方；
- `refundRegistrationCharge`（挂号退费）→ 依赖挂号，需回退号源。

## 开方 → 发药 业务流（临床诊疗 → 药品管理）

门诊医生工作站开立成药/中草药处方（`dms_medicine_prescription_record` / `dms_herbal_prescription_record`），引用药品字典（`dms_drug`）、剂量（`dms_dosage`）；处方转账单进入收费；药房医生工作站按处方发药并扣减药品库存；医技工作站开立的检查/检验走非药品诊疗项（`dms_non_drug`）。

## 对账 / 日结 业务流（财务）

对帐员工作站做操作员结算（`bms_operator_settle_record`）、日结与发票（`bms_invoice_record`），汇总当日收缴费流水——结算模块依赖收费模块。

## 端到端主链路

```
挂号 → 就诊/病历 → 开方(药/非药) → 收费 → 发药/执行 → 对账结算
 │依赖排班·患者           │依赖药品        │依赖挂号·药品        │依赖收费
```

链路上任一环节被改造，其**所有上游依赖方**（经"依赖功能"传递闭包）都需要回归测试——这正是用知识图谱做需求影响校验的价值所在。
