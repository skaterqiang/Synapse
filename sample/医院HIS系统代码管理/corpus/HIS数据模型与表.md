---
corpusId: his-corp-datamodel-003
title: "HIS数据模型与表"
domain:
  id: his
  label: "医院HIS系统代码管理"
profileId: bfo-lite
source:
  name: "HIS系统功能与架构.md"
  path: "note/sample/医院HIS系统代码管理/01-HIS系统功能与架构.md"
generator: "Synapse-Corpus/1.0"
generatedAt: "2026-09-18T00:00:00Z"
---

# HIS 数据模型与表

数据实体来自 MyBatis Generator 生成的模型类（`code/entities/*.java`），类名蛇形映射为表名，字段的外键关系由实体属性名（如 `patientId`、`skdId`、`deptId`）还原。

## 核心表与主外键

| 表（实体） | 业务域 | 关键字段（外键→被引用） | 说明 |
|---|---|---|---|
| pms_patient | 患者管理 | dept/channel | 患者档案，全链路主数据 |
| sms_dept | 系统管理 | — | 科室字典 |
| sms_staff | 系统管理 | dep_id→sms_dept | 医护人员，归属科室 |
| sms_skd | 系统管理 | dep_id→sms_dept, staff_id→sms_staff | 排班号源（remain 限额） |
| dms_registration | 临床诊疗 | patient_id→pms_patient, skd_id→sms_skd, dept_id→sms_dept | 挂号记录 |
| dms_case_history | 临床诊疗 | patient_id→pms_patient, staff_id→sms_staff | 病例/既往史 |
| dms_medicine_prescription_record | 临床诊疗 | registration_id→dms_registration | 成药处方 |
| dms_herbal_prescription_record | 临床诊疗 | registration_id→dms_registration | 中草药处方 |
| dms_drug | 药品管理 | — | 药品字典（含库存） |
| dms_non_drug | 药品管理 | — | 非药品诊疗项（检查/检验） |
| bms_bills_record | 财务管理 | registration_id→dms_registration | 账单记录（挂号/处方转账单） |
| bms_operator_settle_record | 财务管理 | — | 操作员结算/日结 |

## 从代码得到的确定性外键

`DmsRegistration.java` 实体字段：`patientId`、`skdId`、`deptId`、`status`、`bindStatus`、`attendanceDate`——即 **挂号同时引用 患者、排班、科室** 三张表；配合 `DmsRegistrationService` 注释（写 `bms_bills_record`），挂号是连接"患者域 / 系统域 / 财务域"的枢纽事实表。

`BmsFeeService` 以 `registrationId` 为查询主键（`listChargeByRegistrationId`、`listRefundByRegistrationId`），说明 **收费/退费账单强依赖挂号记录**，删除或改造挂号结构会直接波及收费域。

## 数据实体被"读写"归属（影响分析用）

- `dms_registration`：挂号 写；收费、病历、处方 读；
- `sms_skd`：排班 写（扣/退号源）；挂号 读；
- `pms_patient`：患者管理 写；挂号、病历、收费 读；
- `dms_drug`：药品管理 写（库存）；开方、发药、退费 读写；
- `bms_bills_record`：挂号、开方 生成写；收费、结算 读/改状态。

某张表结构变更（加列/改类型）时，沿"模块→读写→数据实体"反查，可列出需同步改造的功能与工作站——这是数据层影响面的来源。
