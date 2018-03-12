import { getShippingAddress } from '../shipping/internal-shipping-addresses.mock';
import isAddressEqual from './is-address-equal';

describe('isAddressEqual', () => {
    it('returns true if addresses are equal', () => {
        const output = isAddressEqual(getShippingAddress(), getShippingAddress());

        expect(output).toEqual(true);
    });

    it('returns false if addresses are different', () => {
        const output = isAddressEqual(getShippingAddress(), {
            ...getShippingAddress(),
            addressLine1: '1 Foobar St',
        });

        expect(output).toEqual(false);
    });

    it('returns true if addresses have different values for ignored fields', () => {
        expect(isAddressEqual(
            getShippingAddress(),
            { ...getShippingAddress(), id: '123' }
        )).toEqual(true);

        expect(isAddressEqual(
            getShippingAddress(),
            { ...getShippingAddress(), provinceCode: '123' }
        )).toEqual(true);
    });
});
