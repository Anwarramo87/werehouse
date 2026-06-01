import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Zod schema for employee termination
export const terminateEmployeeSchema = z.object({
  employeeId: z.string().min(1, 'Employee ID is required'),
  terminationDate: z.string().datetime({ message: 'Invalid date format. Use ISO 8601 format' }),
  terminationType: z.enum(['resignation', 'termination'], {
    message: 'Termination type must be either "resignation" or "termination"',
  }),
  reason: z.string().min(10, 'Reason must be at least 10 characters').max(500, 'Reason must not exceed 500 characters'),
  notes: z.string().max(1000, 'Notes must not exceed 1000 characters').optional(),
});

// Create DTO class from Zod schema
export class TerminateEmployeeZodDto extends createZodDto(terminateEmployeeSchema) {}

// Type inference for use in service
export type TerminateEmployeeInput = z.infer<typeof terminateEmployeeSchema>;
