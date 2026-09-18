---
id: s2hs0a1b2c3d01
title: "医院HIS系统功能与架构"
tags: ["示例", "HIS"]
pinned: 0
favorited: 0
createdAt: 1789000000000
updatedAt: 1789000000000
source: local:sample/医院HIS系统代码管理/01-HIS系统功能与架构.md
---

# HIS 系统功能与架构

素材取自开源项目 **TANGKUO/HIS**（详见 `code/SOURCE.md`）。系统按"数据流量、流向及处理过程"划分为**四大业务域**，诊疗活动由**六类工作站**协同完成；代码用包前缀区分四个子系统。

## 技术栈与形态

- 后端：Spring Boot 2.x + MyBatis（`HIS-master` 单体）；同一套业务另拆为 Spring Cloud 微服务（`his-cloud`：service-dms/bms/pms/sms + Eureka 注册 + Zuul 网关 + Feign 调用）。
- 前端：`HIS-web`（Vue + Element-UI，诊疗端）、`HIS-app`（Uni-app，患者端）。
- 数据模型：MyBatis Generator 生成的实体（`HIS-mbg`），类名蛇形映射为表名。

## 四大业务域 × 子系统前缀

| 业务域 | 前缀 | 职责 | 代表实体（`code/entities/`） |
|---|---|---|---|
| 临床诊疗 | Dms | 挂号、就诊、病历、诊断、处方开立 | `DmsRegistration`、`DmsCaseHistory`、`DmsMedicinePrescriptionRecord`、`DmsHerbalPrescriptionRecord` |
| 药品管理 | Dms | 药品字典、库存、发药、退费 | `DmsDrug`、`DmsNonDrug` |
| 财务管理 | Bms | 收缴费、账单、发票、对账结算 | `BmsBillsRecord`、`BmsOperatorSettleRecord` |
| 患者管理 | Pms | 患者建档、病历号、就诊人 | `PmsPatient` |
| 系统管理 | Sms | 科室、员工、角色权限、排班 | `SmsDept`、`SmsStaff`、`SmsSkd` |

## 六大工作站 → 功能模块

- **门诊医生工作站**：挂号、就诊病历、开方（读患者/排班）；
- **药房医生工作站**：药品管理、药房发药；
- **医技医生工作站**：医技诊疗项（检查/检验，走非药品诊疗项 `DmsNonDrug`）；
- **收费员工作站**：收缴费、退费；
- **对帐员工作站**：对账结算、日结、发票；
- **管理员工作站**：排班、科室员工、角色权限维护。

## 图谱映射（本样例抽取口径）

架构信息在 `ontology/his.ttl` 中被形式化为：

- 类：`FunctionModule`（其下 `ClinicalModule`/`DrugModule`/`FinanceModule`/`PatientModule`/`SystemModule`）、`Workstation`、`Service`、`DataEntity`；
- 谓词：`includes`（工作站→功能）、`hostedOn`（功能→微服务）、`readsWrites`（功能→数据实体）、`dependsOnFunction`（功能→功能，**传递**）、`callsService`（服务→服务，**传递**）。

对应实例见 `graph/his-graph.json`：13 个功能模块 + 6 个工作站 + 4 个微服务 + 12 个数据实体节点。下一篇（笔记 02）沿 `dependsOnFunction` 展开真实调用链依据。
