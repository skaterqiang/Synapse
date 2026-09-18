# 代码来源说明（SOURCE）

本目录 `code/` 是从真实开源医院信息系统 **TANGKUO/HIS** 中截取的**代表性子集**，用于「代码 → 知识图谱 → 需求影响校验」的展示，并非完整仓库。

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/TANGKUO/HIS （镜像 https://gitcode.com/gh_mirrors/his/HIS ） |
| 许可证 | Apache License 2.0（见同目录 `LICENSE`） |
| 抓取 commit | `bba3c924749d366c6f275499f9c03322adcd374f`（2019-07-13） |
| 技术栈 | Spring Cloud + Spring Boot 2.x + MyBatis + Vue + Element-UI + Uni-app |
| 包前缀 | `com.neu.his`（东北大学 NEU 实训课设） |

## 原仓库整体结构（未全部纳入）

```
HIS
├── HIS-master        单体应用（本子集主要来源）
│   ├── HIS-mbg        MyBatis Generator 生成的实体（= 数据模型）
│   ├── HIS-api        Controller 层（按 dms/bms/sms/pms 分包）
│   ├── HIS-service    Service 层（HIS-dms-service / HIS-bms-service / HIS-pms-service / HIS-sms-service）
│   └── HIS-common     DTO / 公共
├── his-cloud         微服务版（service-bms/dms/pms/sms + eureka/zuul/config/…）
├── HIS-web           诊疗前端（Vue）
├── HIS-app           患者前端（Uni-app）
└── document          业务流程图 / 需求（原仓库为图片，未纳入）
```

## 本目录子集清单

- `entities/`：12 个 MyBatis 生成实体，覆盖四大业务域核心表（挂号、成药/中草药处方、药品、非药品诊疗项、病历、账单、结算、患者、员工、科室、排班）；
- `controllers/`：挂号、药品、收缴费、排班四个 Controller；
- `services/`：挂号服务、收缴费服务接口（其注释揭示了真实跨模块调用链）；
- `modules/`：`HIS-master` 与 `HIS-service` 的 `pom.xml` 模块清单；
- `README.md`、`LICENSE`：上游原样保留。

## 模块前缀 → 业务域对照

| 前缀 | 子系统 | 业务域 | 典型表 |
|---|---|---|---|
| Dms | 临床诊疗/药品管理 | 诊疗、处方、药品、挂号 | dms_registration / dms_medicine_prescription_record / dms_drug |
| Bms | 财务/收费结算 | 收费、账单、结算、发票 | bms_bills_record / bms_operator_settle_record |
| Pms | 患者管理 | 患者档案 | pms_patient |
| Sms | 系统管理 | 科室、员工、角色权限、排班、工作量 | sms_dept / sms_staff / sms_skd |

> 数据实体表名由类名蛇形映射（如 `DmsRegistration` → `dms_registration`），这一点在 `services/DmsRegistrationService.java` 的方法注释中被直接印证（"向 dms_registration 插入信息 / 向 bms_bills_record 中插入账单记录 / 修改 sms_skd 排班限额"）。
