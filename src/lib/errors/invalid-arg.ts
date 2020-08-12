import { CustomError } from './custom-error';

export class InvalidArg extends CustomError {
  constructor(argName: string, helpMessage: string) {
    super(`Invalid argument ${argName}`);
    this.userMessage = helpMessage;
  }
}
