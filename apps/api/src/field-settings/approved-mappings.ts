export type UnitReference = {
  bitrix24Id: number;
  bitrix24Code: string;
  moyskladId: string | null;
  moyskladCode: string | null;
  status: 'configured' | 'unmapped';
};
export type PriceTypeReference = {
  bitrix24Id: number;
  bitrix24Code: string;
  moyskladId: string | null;
  moyskladLabel: string | null;
  status: 'configured' | 'excluded';
};

export const APPROVED_UNITS: UnitReference[] = [
  { bitrix24Id: 3, bitrix24Code: '112', moyskladId: '250d5161-f815-4524-85b6-fd6afebc1ad6', moyskladCode: '112', status: 'configured' },
  { bitrix24Id: 5, bitrix24Code: '163', moyskladId: '8e2eb543-99e9-4077-bc31-93b1359de9c4', moyskladCode: '163', status: 'configured' },
  { bitrix24Id: 7, bitrix24Code: '166', moyskladId: '2ec1170c-3f69-4409-87bb-c68e0011b275', moyskladCode: '166', status: 'configured' },
  { bitrix24Id: 9, bitrix24Code: '796', moyskladId: '19f1edc0-fc42-4001-94cb-c9ec9c62ec10', moyskladCode: '796', status: 'configured' },
  { bitrix24Id: 10, bitrix24Code: '778', moyskladId: '605a1781-b652-11e3-feb0-002590a28eca', moyskladCode: '778', status: 'configured' },
  { bitrix24Id: 12, bitrix24Code: '839', moyskladId: 'f5611dc2-1acd-11e7-7a31-d0fd001085d2', moyskladCode: '839', status: 'configured' },
  { bitrix24Id: 22, bitrix24Code: '736', moyskladId: '647775b2-3b57-409b-910e-8b17940b279f', moyskladCode: '736', status: 'configured' },
  { bitrix24Id: 1, bitrix24Code: '6', moyskladId: 'dfe54549-ec98-4fd7-ad1b-215162a9199a', moyskladCode: '006', status: 'configured' },
  { bitrix24Id: 18, bitrix24Code: '55', moyskladId: '7cfd013f-33d0-448a-a4aa-1c8bb2e05417', moyskladCode: '055', status: 'configured' },
  { bitrix24Id: 14, bitrix24Code: '1720010507', moyskladId: null, moyskladCode: null, status: 'unmapped' },
  { bitrix24Id: 16, bitrix24Code: '1720532980', moyskladId: null, moyskladCode: null, status: 'unmapped' },
  { bitrix24Id: 20, bitrix24Code: '1762891510', moyskladId: null, moyskladCode: null, status: 'unmapped' },
];

export const APPROVED_PRICE_TYPES: PriceTypeReference[] = [
  { bitrix24Id: 2, bitrix24Code: 'BASE', moyskladId: '02b04e92-d515-11e2-e753-7054d21a8d1e', moyskladLabel: 'Розница', status: 'configured' },
  { bitrix24Id: 4, bitrix24Code: 'opt', moyskladId: 'f2ead8ce-de34-11e5-7a69-8f550015ae90', moyskladLabel: 'Опт', status: 'configured' },
  { bitrix24Id: 6, bitrix24Code: 'vip', moyskladId: '78a9ffa3-0712-11e6-7a69-8f5500119e54', moyskladLabel: 'VIP', status: 'configured' },
  { bitrix24Id: 8, bitrix24Code: 'dil', moyskladId: '1b4623d2-2857-11eb-0a80-044e00021305', moyskladLabel: 'Дилер', status: 'configured' },
  { bitrix24Id: 12, bitrix24Code: 'ozon', moyskladId: '5c8a8396-b503-11ee-0a80-0d3e00059f64', moyskladLabel: 'Ozon', status: 'configured' },
  { bitrix24Id: 14, bitrix24Code: 'mdo', moyskladId: '61161db9-7f0b-11ee-0a80-0b350015853e', moyskladLabel: 'М. До скидки', status: 'configured' },
  { bitrix24Id: 16, bitrix24Code: 'rrc', moyskladId: '138eeb4d-82c0-11ed-0a80-0ffb0028e290', moyskladLabel: 'РРЦ', status: 'configured' },
  { bitrix24Id: 10, bitrix24Code: 'mark', moyskladId: null, moyskladLabel: null, status: 'excluded' },
  { bitrix24Id: 18, bitrix24Code: 'ali', moyskladId: null, moyskladLabel: null, status: 'excluded' },
  { bitrix24Id: 20, bitrix24Code: 'MIN', moyskladId: null, moyskladLabel: null, status: 'excluded' },
  { bitrix24Id: 22, bitrix24Code: 'ZAKUP', moyskladId: null, moyskladLabel: null, status: 'excluded' },
];

export const APPROVED_MOYSKLAD_PRICE_TYPES = [
  { id: '02b04e92-d515-11e2-e753-7054d21a8d1e', label: 'Розница' },
  { id: 'f2ead8ce-de34-11e5-7a69-8f550015ae90', label: 'Опт' },
  { id: '78a9ffa3-0712-11e6-7a69-8f5500119e54', label: 'VIP' },
  { id: '1b4623d2-2857-11eb-0a80-044e00021305', label: 'Дилер' },
  { id: '181fccd0-7736-11ed-0a80-080900027768', label: 'ВБ' },
  { id: '47e91e27-ad13-11f1-0a80-144700177791', label: 'ВБ ВентМаркет' },
  { id: '5c8a8396-b503-11ee-0a80-0d3e00059f64', label: 'Ozon' },
  { id: '7c45db73-7b9e-11f1-0a80-182500121f3e', label: 'Ozon ВентМаркет' },
  { id: 'e4a858d7-e190-11f0-0a80-1059000f9c17', label: 'ЯМ' },
  { id: '61161db9-7f0b-11ee-0a80-0b350015853e', label: 'М. До скидки' },
  { id: '138eeb4d-82c0-11ed-0a80-0ffb0028e290', label: 'РРЦ' },
  { id: 'a88d2683-3e1f-11f1-0a80-185000073e51', label: 'Минимальная цена Ozon' },
];

export const APPROVED_DICTIONARY_PAIRS = {
  service: [
    [87402, '0739768a-9611-11eb-0a80-02fe0030d850'], [87404, '138ba20f-9611-11eb-0a80-09f30031a1bd'],
    [87406, '13c6b76f-dc8b-11ef-0a80-14a2002bad01'], [87408, '1c015bd9-8e75-11e3-7988-002590a28eca'],
    [87410, '1f3aee5b-7a16-11ed-0a80-0e4b003bd0de'], [87412, '211d13d3-f3f3-11ed-0a80-0d7700134652'],
    [87414, '212c3425-8e77-11e3-f329-002590a28eca'], [87416, '2429260a-8e75-11e3-ae91-002590a28eca'],
    [87418, '25e77ed7-c084-11ec-0a80-0e8a001a9d4f'], [87420, '29251eea-b0b8-11ec-0a80-070300023cdb'],
    [87422, '29572e0e-8e75-11e3-151d-002590a28eca'], [87424, '2a83109a-8e77-11e3-4a28-002590a28eca'],
    [87426, '35041f84-8e77-11e3-0b6c-002590a28eca'], [87428, '3984efe8-86ab-11ed-0a80-0cd100882708'],
    [87430, '3fb3b201-d1eb-11ec-0a80-08ba0005c288'], [87432, '418e7b55-9611-11eb-0a80-02fe0030e557'],
    [87434, '527065e5-31a4-11ec-0a80-0519000835b2'], [87436, '5aa2457d-8e76-11e3-5e81-002590a28eca'],
    [87438, '5e46388c-30ce-11ec-0a80-07f20005a3f4'], [87440, '5e74d305-7244-11ee-0a80-0dd10017b294'],
    [87442, '7bc6a0d6-1419-11ef-0a80-01bb00142540'], [87444, '8b5a2455-4b17-11ed-0a80-01a5000b0b4c'],
    [87446, '8db8e733-56b3-11ee-0a80-0751000d5c16'], [87448, '92165f84-ebd3-11e3-e38a-002590a28eca'],
    [87450, '95c5d680-31a8-11ec-0a80-07f800089ee0'], [87452, '9ba4d740-30d5-11ec-0a80-050d0005f97f'],
    [87454, '9ef09c73-cb92-11e3-b94f-002590a28eca'], [87456, 'a676dd33-332c-11ed-0a80-0ce600045d6c'],
    [87458, 'b2ee2780-9610-11eb-0a80-047b003038f0'], [87460, 'b3092814-3b19-11ec-0a80-07760020ae86'],
    [87462, 'b6b1c19f-2d1c-11ec-0a80-039500004784'], [87464, 'c176e845-317a-11ec-0a80-0d3a000523db'],
    [87466, 'cbf43d9e-9ceb-11ef-0a80-0374001dfff3'], [87468, 'cf0ab1df-22bd-11ed-0a80-014200037ec1'],
    [87470, 'd8496915-d111-11ec-0a80-00f400b0d1a6'], [87472, 'e7e7300a-8e76-11e3-d8ac-002590a28eca'],
    [87474, 'ea915cb0-9610-11eb-0a80-06f300319518'], [87476, 'ef5999e6-7925-11ec-0a80-0855000767c9'],
    [87478, 'f11836ec-9610-11eb-0a80-06f300319643'], [87480, 'f698273f-8e76-11e3-88a5-002590a28eca'],
    [146582, '4fe3995a-2830-11f1-0a80-0549003d153a'], [146584, '7df37bb6-252b-11f1-0a80-1070003a882d'],
    [146592, '2cdeb7b6-3991-11f1-0a80-1312001a35af'], [146594, 'c450c8d9-3990-11f1-0a80-1312001a267e'],
    [564816, 'c6bbab1a-3ef6-11f1-0a80-13210013b832'], [564818, 'b4f6ffd8-97f5-11f1-0a80-01f9001bbad4'],
  ] as Array<[number, string]>,
  paymentMethod: [
    [87494, 'b28a8751-d985-11eb-0a80-0dc40004c745'],
    [87506, '522ea159-dc5f-11f0-0a80-190b0001bdcb'],
    [87508, 'b2ff1d3a-d985-11eb-0a80-096a0004d08c'],
    [87510, 'b2d5de19-d985-11eb-0a80-05bb0004d798'],
    [87512, 'b2b17176-d985-11eb-0a80-096a0004d07f'],
  ] as Array<[number, string]>,
};

export const DEFAULT_FIELD_SETTINGS = {
  schemaVersion: 1,
  rules: [] as unknown[],
  groups: [] as unknown[],
  references: {
    units: APPROVED_UNITS,
    priceTypes: APPROVED_PRICE_TYPES,
    dictionaries: [
      {
        key: 'service',
        bitrix24Field: 'UF_CRM_1766085949',
        bitrix24ListId: '42',
        moyskladAttributeId: '0ad997c8-8e75-11e3-1ec9-002590a28eca',
        moyskladDirectoryId: 'f0177126-8e74-11e3-b761-002590a28eca',
        pairs: APPROVED_DICTIONARY_PAIRS.service.map(([bitrix24Id, moyskladId]) => ({ bitrix24Id, moyskladId })),
      },
      {
        key: 'payment-method',
        bitrix24Field: 'UF_CRM_1766072752',
        bitrix24ListId: '44',
        moyskladAttributeId: 'f214f966-dc1a-11f0-0a80-0ef700278459',
        moyskladDirectoryId: '0ecffb86-d8a3-11eb-0a80-0dbc000256e5',
        pairs: APPROVED_DICTIONARY_PAIRS.paymentMethod.map(([bitrix24Id, moyskladId]) => ({ bitrix24Id, moyskladId })),
      },
    ],
    namedPairs: [],
  },
};

