export interface WarehouseDetails {
  id: string;
  name: string;
  code: string;
  address?: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  totalQuantity: number;
  totalAvailable: number;
  totalReserved: number;
  stockRecordCount: number;
}
