# 2FA Extension Specification

## Terminology

### Device Key (DK)

Each device with Tonkeeper installed generates a unique Device Key (DK) for a single account. It is unique for each
pair (device, account) and is used to identify the device from which a message was sent.

### **Service Key (SK)**

The service key is stored on the Tonkeeper backend and is required to sign any message sent to the extension. Any
message signed with the DK must be signed with the SK as well. The SK is unique for each account.

### Seed

The seed phrase is not used for regular wallet use but serves as a backup to restore access to the wallet when 
access to the all DKs is lost. 

## Installing extension

When installing the extension, following steps should be taken:
1. Add the extension to the list of extensions in the wallet.
2. Create and send a message to the extension with the following scheme:
```tl-b
install#43563174 service_pubkey:uint256 seed_pubkey:uint256 device_pubkeys:(Dict uint32 uint256) = InternalMessage;
```
where:
- `service_pubkey` is the public key of the service key.
- `seed_pubkey` is the public key of the seed phrase.
- `device_pubkeys` is a dictionary of device keys, where the key is the device ID and the value is the device key.

The `state_init` data should be constructed as follows:
```typescript
beginCell()
    .storeUint(0, 32)
    .storeAddress(walletAddress)
    .storeUint(0, 256)
    .storeUint(0, 256)
    .storeDict()
    .storeUint(0, 2)
    .storeUint(0, 64)
    .endCell();
```

After the above message is sent, the extension will send a message to the wallet that will disable the public
key signature authorization.

## Balance

Sending 255 transfers is required 0.16 ton to execute such transaction before the transfers is made. So, it is 
proposed to keep at least 0.3 ton on the balance and refill the extension balance if it is less than 0.2 ton.
To replenish the balance, simple message without body should be sent to the extension.

## Authorization

There are 3 types of authorization:
- 2fa: the message is signed with the device key and the service key.
- 2fa with Seed: the message is signed with the seed key and the service key.
- Seed: the message is signed with the seed key.

### 2FA

To authorize a message with 2FA, the following scheme of the message should be used:

```typescript
const dataToSign = beginCell()
    .storeUint(opCode, 32) // op code of the method
    .storeUint(seqno, 32)
    .storeUint(validUntil, 64)
    .storeBuilder(payload) // payload of the method
    .endCell();
const signature1 = sign(dataToSign.hash(), servicePrivateKey);
const signature2 = sign(dataToSign.hash(), devicePrivateKey);

const body = beginCell()
    .storeBuffer(signature1)
    .storeRef(
        beginCell()
            .storeBuffer(signature2)
            .storeUint(deviceId, 32) // device id of the device key
    )
    .storeSlice(dataToSign.beginParse());

return body.endCell();
```

### 2FA with Seed

To authorize a message with 2FA, the following scheme of the message should be used:

```typescript
const dataToSign = beginCell()
    .storeUint(opCode, 32) // op code of the method
    .storeUint(seqno, 32)
    .storeUint(validUntil, 64)
    .storeBuilder(payload) // payload of the method
    .endCell();
const signature1 = sign(dataToSign.hash(), servicePrivateKey);
const signature2 = sign(dataToSign.hash(), seedPrivateKey);

const body = beginCell()
    .storeBuffer(signature1)
    .storeRef(beginCell().storeBuffer(signature2))
    .storeSlice(dataToSign.beginParse());

return body.endCell();
```

### Seed Authorization

To authorize a message with Seed, the following scheme of the message should be used:

```typescript
const dataToSign = beginCell()
    .storeUint(opCode, 32)
    .storeUint(seqno, 32)
    .storeUint(validUntil, 64)
    .storeBuilder(payload)
    .endCell();
const signature = sign(dataToSign.hash(), seedPrivateKey);

const body = beginCell().storeBuffer(signature).storeSlice(dataToSign.beginParse());

return body.endCell();
```

### TL-B Schemes

```tlb
signed_2fa_external#_ 
    service_signature:bits512 
    ref_with_device_signature:^[device_signature:bits512 device_id:uint32] 
    op_code:uint32 seqno:uint32 valid_until:uint64 payload:Cell
    = ExternalMsgBody;
signed_2fa_seed_external#_ 
    service_signature:bits512 
    ref_with_seed_signature:^[seed_signature:bits512] 
    op_code:uint32 seqno:uint32 valid_until:uint64 payload:Cell
    = ExternalMsgBody;
signed_seed_external#_
    seed_signature:bits512
    op_code:uint32 seqno:uint32 valid_until:uint64 payload:Cell
    = ExternalMsgBody;
```

## Methods

### `send_actions`

Requires [2FA](#2FA) authorization.

```tl-b
send_actions#b15f2c8c msg:^Cell mode:uint8 = ExternalMessage;
```

where:
- `msg` is a serialized message that would be put into the `send_raw_msg` method. It is supposed that this method is
  used to send messages to the wallet, but any message can be sent in case of necessity.
- `mode` is a mode of the message that would be put into the `send_raw_msg` method.

### `add_device_key`

Requires [2FA](#2FA) authorization.

```tl-b
pubkey$_ pubkey:uint256 = Pubkey;
add_device_key#0a73fcb4 newDeviceID:uint32 pubkey:^(Pubkey) = ExternalMessage;
```

where:
- `newDeviceID` is the ID of the new device.
- `pubkey` is the public key of the new device.

Constraints:
- The device with the same ID should not be authorized yet.

### `remove_device_key`

Requires [2FA](#2FA) authorization.

```tl-b
remove_device_key#b3b4b8f3 deviceID:uint32 = ExternalMessage;
```

where:
- `deviceID` is the ID of the device to be unauthorized.

### `fast_recover_process`

Requires [2FA with Seed](#2FA-with-Seed) authorization.

```tl-b
fast_recover_process#59c538dd newDevicePubkey:uint256 newDeviceId:uint32 = ExternalMessage;
```

where:
- `newDevicePubkey` is the public key of the new device.
- `newDeviceId` is the ID of the new device.

How it works:
1. The extension received a message with the `fast_recover_process` method.
2. If it is the first time the method is called, extension state turns to the `fast_recover_process` state.
3. Before performing the next step, a delay of 24 hours must be completed.
4. If the current state is `fast_recover_process`, the extension will delete all previous device keys and
   authorize the new device key.

### `cancel_fast_recovery`

Requires [2FA with Seed](#2FA-with-Seed) authorization.

```tl-b
cancel_fast_recovery#30f0a407 = ExternalMessage;
```

This method is used to cancel the request to recover access. If the current state is `fast_recover_process` it resets to the 
`none` state.

### `slow_recover_process`

Requires [Seed](#Seed) authorization.

```tl-b
slow_recover_process#59c538dd newDevicePubkey:uint256 newDeviceId:uint32 = ExternalMessage;
```

where:
- `newDevicePubkey` is the public key of the new device.
- `newDeviceId` is the ID of the new device.

How it works:
1. The extension received a message with the `slow_recover_process` method.
2. If it is the first time the method is called, extension state turns to the `slow_recover_process` state.
3. Before performing the next step, a delay of 336 hours (2 weeks) must be completed.
4. If the current state is `slow_recover_process`, the extension will delete all previous device keys and
   authorize the new device key.

### `remove_extension`

Requires [2FA](#2FA) authorization.

```tl-b
remove_extension#9d8084d6 = ExternalMessage;
```

This method is used to delete the extension from the wallet. It enables the public key signature authorization, removes
the extension from the list of extensions, and deletes the extension smart contract.

WARNING: This method is dangerous because Seed can be compromised, but the fact that it is compromised may be unknown.
The attacker can wait until the extension is deleted and then use the stolen seed phrase to directly access the wallet.
It is strongly recommended to use `delegating` method instead of `remove_extension`.

### `delegating`

Requires [Seed](#Seed-Authorization) authorization.

```tl-b
delegating#23d9c15c new_state_init:^Cell forward_amount:Coins = ExternalMessage;
```

where:
- `new_state_init` is a state_init of the new extension that will be created after disabling the current extension.
- `forward_amount` is the amount of ton that will be transferred to the new extension when creating it.

This method is used to disable the extension. It removes the extension from the list of extensions and creates a
new extension with the `new_state_init` state and adds new extension to the list of extensions. 

How it works:
1. The extension received a message with the `delegating` method.
2. If it is the first time the method is called, extension state turns to the `delegating` state.
3. Before performing the next step, a delay of 72 hours must be completed.
4. If the current state is `delegating`, the extension will send a message to the wallet to create a new extension 
with the `new_state_init` state.

### `cancel_slow_recovery_and_delegating`

Requires [Seed](#Seed-Authorization) authorization.

```tl-b
cancel_slow_recovery_and_delegating#b3b4b8f3 = ExternalMessage;
```

This method is used to cancel the and `delegating`. If the current state is `disable`, it resets to the
`none` state.

### TL-B schemes

```tl-b
install#43563174 service_pubkey:uint256 seed_pubkey:uint256 device_pubkeys:(Dict uint32 uint256) = InternalMessage;

send_actions#b15f2c8c msg:^Cell mode:uint8 = ExternalMessage;
authorize_device#0a73fcb4 newDeviceID:uint32 pubkey:^(Pubkey) = ExternalMessage;
unauthorize_device#b3b4b8f3 deviceID:uint32 = ExternalMessage;
recover_access#59c538dd newDevicePubkey:uint256 newDeviceId:uint32 = ExternalMessage;
cancel_request#30f0a407 = ExternalMessage;
destruct#9d8084d6 = ExternalMessage;
disable#23d9c15c new_state_init:^Cell forward_amount:Coins = ExternalMessage;
cancel_disabling#b3b4b8f3 = ExternalMessage;
```

## Get Methods

- `int get_seqno()` - returns the current seqno.
- `int get_wallet_addr()` - returns the wallet address.
- `int get_service_pubkey()` - returns the service public key.
- `int get_seed_pubkey()` - returns the seed public key.
- `int get_device_pubkey(int device_id)` - returns the device public key by device ID.
- `int get_device_pubkeys()` - returns the hash map of device pubkeys. Key is uint32 device id, value is uint256 pubkey.
- `(int, int, tuple) get_recover_state()` - returns the recover state. First parameter is the `state tag`. 
Second parameter is the `blocked_until`. Third parameter is the state params.
- `int get_gas_fee_for_processing_send_actions(cell msg, int msg_actions, int ext_actions)` - returns the gas fee 
for processing the `send_actions` method. The first parameter is the serialized message. The second parameter is the
number of outbound messages in the action list. The third parameter is the number of extended actions in the action list.