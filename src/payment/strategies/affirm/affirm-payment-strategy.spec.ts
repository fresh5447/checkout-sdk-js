import { createClient as createPaymentClient } from '@bigcommerce/bigpay-client';
import { createAction, Action } from '@bigcommerce/data-store';
import { createRequestSender } from '@bigcommerce/request-sender';
import { merge } from 'lodash';
import { of, Observable } from 'rxjs';

import { getBillingAddressState } from '../../../billing/billing-addresses.mock';
import { getCartState } from '../../../cart/carts.mock';
import { createCheckoutStore, CheckoutRequestSender, CheckoutStore, CheckoutValidator } from '../../../checkout';
import { MissingDataError } from '../../../common/error/errors';
import { getConfigState } from '../../../config/configs.mock';
import { getCustomerState } from '../../../customer/customers.mock';
import { OrderActionCreator, OrderActionType, OrderRequestBody, OrderRequestSender } from '../../../order';
import { OrderFinalizationNotRequiredError } from '../../../order/errors';
import { getOrderRequestBody } from '../../../order/internal-orders.mock';
import { getOrderState } from '../../../order/orders.mock';
import { getPaymentMethodsState } from '../../../payment/payment-methods.mock';
import { getConsignmentsState } from '../../../shipping/consignments.mock';
import { PaymentArgumentInvalidError, PaymentMethodCancelledError, PaymentMethodInvalidError } from '../../errors';
import PaymentActionCreator from '../../payment-action-creator';
import { PaymentActionType } from '../../payment-actions';
import PaymentMethod from '../../payment-method';
import PaymentMethodActionCreator from '../../payment-method-action-creator';
import PaymentMethodRequestSender from '../../payment-method-request-sender';
import { getAffirm } from '../../payment-methods.mock';
import PaymentRequestSender from '../../payment-request-sender';

import { Affirm } from './affirm';
import AffirmPaymentStrategy from './affirm-payment-strategy';
import AffirmScriptLoader from './affirm-script-loader';
import { getAffirmScriptMock } from './affirm.mock';

describe('AffirmPaymentStrategy', () => {
    let affirm: Affirm;
    let checkoutRequestSender: CheckoutRequestSender;
    let orderActionCreator: OrderActionCreator;
    let orderRequestSender: OrderRequestSender;
    let payload: OrderRequestBody;
    let paymentActionCreator: PaymentActionCreator;
    let paymentMethodActionCreator: PaymentMethodActionCreator;
    let paymentMethod: PaymentMethod;
    let submitOrderAction: Observable<Action>;
    let submitPaymentAction: Observable<Action>;
    let store: CheckoutStore;
    let strategy: AffirmPaymentStrategy;
    let affirmScriptLoader: AffirmScriptLoader;

    beforeEach(() => {
        const requestSender = createRequestSender();

        affirm = getAffirmScriptMock();
        affirm.checkout.open = jest.fn();
        affirm.ui.error.on = jest.fn();
        paymentMethod = getAffirm();
        orderRequestSender = new OrderRequestSender(requestSender);
        store = createCheckoutStore({
            customer: getCustomerState(),
            config: getConfigState(),
            cart: getCartState(),
            paymentMethods: getPaymentMethodsState(),
            consignments: getConsignmentsState(),
            billingAddress: getBillingAddressState(),
            order: getOrderState(),
        });
        checkoutRequestSender = new CheckoutRequestSender(requestSender);
        orderActionCreator = new OrderActionCreator(orderRequestSender, new CheckoutValidator(checkoutRequestSender));
        paymentActionCreator = new PaymentActionCreator(
            new PaymentRequestSender(createPaymentClient()),
            orderActionCreator
        );
        paymentMethodActionCreator = new PaymentMethodActionCreator(new PaymentMethodRequestSender(requestSender));
        affirmScriptLoader = new AffirmScriptLoader();
        strategy = new AffirmPaymentStrategy(
            store,
            orderActionCreator,
            paymentActionCreator,
            paymentMethodActionCreator,
            affirmScriptLoader
        );

        submitOrderAction = of(createAction(OrderActionType.SubmitOrderRequested));
        submitPaymentAction = of(createAction(PaymentActionType.SubmitPaymentRequested));

        jest.spyOn(orderActionCreator, 'submitOrder')
            .mockReturnValue(submitOrderAction);

        jest.spyOn(paymentActionCreator, 'submitPayment')
            .mockReturnValue(submitPaymentAction);

        jest.spyOn(store.getState().paymentMethods, 'getPaymentMethod')
            .mockReturnValue(paymentMethod);

        jest.spyOn(paymentMethodActionCreator, 'loadPaymentMethod')
            .mockResolvedValue(store.getState());

        jest.spyOn(affirmScriptLoader, 'load').mockResolvedValue(affirm);

        payload = merge({}, getOrderRequestBody(), {
            payment: {
                methodId: paymentMethod.id,
                gatewayId: paymentMethod.gateway,
            },
        });
    });

    describe('#initialize()', () => {
        it('throws error if client token is missing', () => {
            jest.spyOn(store.getState().paymentMethods, 'getPaymentMethod')
                .mockReturnValue({
                    ...paymentMethod,
                    clientToken: null,
                });

            return expect(strategy.initialize({ methodId: paymentMethod.id }))
                .rejects.toThrow(MissingDataError);

        });

        it('loads affirm script from snippet with testMode equals to true', async () => {
            paymentMethod.config.testMode = true;
            await strategy.initialize({ methodId: paymentMethod.id });
            expect(affirmScriptLoader.load).toBeCalledWith(paymentMethod.clientToken, true);
        });

        it('loads affirm script from snippet with testMode equals to false', async () => {
            await strategy.initialize({ methodId: paymentMethod.id });
            expect(affirmScriptLoader.load).toBeCalledWith(paymentMethod.clientToken, false);
        });
    });

    describe('#execute()', () => {
        beforeEach(async () => {
            await strategy.initialize({ methodId: paymentMethod.id, gatewayId: paymentMethod.gateway });

            jest.spyOn(affirm.checkout, 'open').mockImplementation(({ onSuccess }) => {
                onSuccess({
                    checkout_token: '1234',
                    created: '1234',
                });
            });
        });

        it('creates order, checkout and payment', async () => {
            jest.spyOn(store, 'dispatch');
            const options = { methodId: 'affirm', gatewayId: undefined };

            await strategy.execute(payload, options);

            expect(store.dispatch).toHaveBeenCalledWith(submitOrderAction);

            expect(orderActionCreator.submitOrder).toHaveBeenCalledWith({ useStoreCredit: false }, options);
            expect(affirm.checkout).toHaveBeenCalled();
            expect(affirm.checkout.open).toHaveBeenCalled();
            expect(affirm.ui.error.on).toHaveBeenCalled();
            expect(store.dispatch).toHaveBeenCalledWith(submitPaymentAction);
            expect(paymentActionCreator.submitPayment).toBeCalledWith({
                methodId: paymentMethod.id,
                paymentData: { nonce: '1234' },
            });
        });

        it('returns cancel error on affirm if users cancel flow', () => {
            jest.spyOn(affirm.checkout, 'open').mockImplementation(({ onFail }) => {
                onFail({
                    reason: 'canceled',
                });
            });

            return expect(strategy.execute(payload))
                .rejects.toThrow(PaymentMethodCancelledError);
        });

        it('returns invalid error on affirm if payment method was invalid', () => {
            jest.spyOn(affirm.checkout, 'open').mockImplementation(({ onFail }) => {
                onFail({
                    reason: 'not canceled',
                });
            });

            return expect(strategy.execute(payload))
                .rejects.toThrow(PaymentMethodInvalidError);
        });

        it('does not create order/payment if methodId is not passed', async () => {
            payload.payment = undefined;
            try {
                await strategy.execute(payload);
            } catch (error) {
                expect(error).toBeInstanceOf(PaymentArgumentInvalidError);
            }
        });

        it('does not create affirm object if config does not exist', () => {
            jest.spyOn(store.getState().config, 'getStoreConfig').mockReturnValue(undefined);

            return expect(strategy.execute(payload)).rejects.toThrow(MissingDataError);
        });

        it('does not create affirm object if billingAddress does not exist', () => {
            jest.spyOn(store.getState().billingAddress, 'getBillingAddress').mockReturnValue(undefined);

            return expect(strategy.execute(payload)).rejects.toThrow(MissingDataError);
        });

        it('does not create affirm object if cart does not exist', () => {
            jest.spyOn(store.getState().cart, 'getCart').mockReturnValue(undefined);

            return expect(strategy.execute(payload)).rejects.toThrow(MissingDataError);
        });

        it('does not create affirm object if order does not exist', () => {
            jest.spyOn(store.getState().order, 'getOrder').mockReturnValue(undefined);

            return expect(strategy.execute(payload)).rejects.toThrow(MissingDataError);
        });
    });

    describe('#deinitialize()', () => {
        it('deinitializes strategy', async () => {
            expect(await strategy.deinitialize()).toEqual(store.getState());
        });
    });

    describe('#finalize()', () => {
        it('throws error to inform that order finalization is not required', () => {

            return expect(strategy.finalize()).rejects.toThrow(OrderFinalizationNotRequiredError);
        });
    });

});
