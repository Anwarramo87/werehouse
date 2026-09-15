import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * The body a badge reader posts to /attendance/public/check-in|check-out.
 *
 * These two endpoints used to take an inline `{ employeeId: string }` type.
 * The global ValidationPipe has no metatype to work with in that case, so it
 * validated nothing: any shape at all reached the handler and the only check
 * was a truthiness test inside it.
 */
export class DevicePunchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  employeeId!: string;
}
