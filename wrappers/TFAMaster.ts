import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export type TFAMasterConfig = {};

export function tFAMasterConfigToCell(config: TFAMasterConfig): Cell {
    return beginCell().endCell();
}

export class TFAMaster implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new TFAMaster(address);
    }

    static createFromConfig(config: TFAMasterConfig, code: Cell, workchain = 0) {
        const data = tFAMasterConfigToCell(config);
        const init = { code, data };
        return new TFAMaster(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async getEstimatedFeesOnSendActions(
        provider: ContractProvider,
        opts: {
            forwardMsg: Cell;
            outputMsgCount: number;
            extendedActionCount: number;
        },
    ): Promise<bigint> {
        const res = await provider.get('get_estimated_fees_on_send_actions', [
            { type: 'cell', cell: opts.forwardMsg },
            { type: 'int', value: BigInt(opts.outputMsgCount) },
            { type: 'int', value: BigInt(opts.extendedActionCount) },
        ]);
        return res.stack.readBigNumber();
    }
}
