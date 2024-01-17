import { Appointment, PaymentStatus, Prisma, UserRole } from '@prisma/client';
import prisma from '../../../shared/prisma';
import { IAuthUser, IGenericResponse } from '../../../interfaces/common';
import { v4 as uuidv4 } from 'uuid';
import ApiError from '../../../errors/ApiError';
import httpStatus from 'http-status';
import { paginationHelpers } from '../../../helpers/paginationHelper';
import { IPaginationOptions } from '../../../interfaces/pagination';
import { appointmentRelationalFields, appointmentRelationalFieldsMapper, appointmentSearchableFields } from './appointment.constants';
import { generateTransactionId } from '../payment/payment.utils';

const createAppointment = async (data: Partial<Appointment>, authUser: IAuthUser) => {
    const { doctorId, doctorScheduleId } = data;
    const isDoctorExists = await prisma.doctor.findFirstOrThrow({
        where: {
            id: doctorId
        }
    });

    if (!isDoctorExists) {
        throw new ApiError(httpStatus.BAD_REQUEST, "Doctor doesn't exists!")
    };

    const isPatientExists = await prisma.patient.findFirstOrThrow({
        where: {
            email: authUser?.email
        }
    });

    if (!isPatientExists) {
        throw new ApiError(httpStatus.BAD_REQUEST, "Patient doesn't exists!")
    };

    const isExistsDoctorSchedule = await prisma.doctorSchedule.findFirst({
        where: {
            id: doctorScheduleId,
            isBooked: false
        }
    });

    if (!isExistsDoctorSchedule) {
        throw new ApiError(httpStatus.BAD_REQUEST, "Doctor Schedule is not available!")
    }

    const videoCallingId: string = uuidv4()

    return await prisma.$transaction(async (transactionClient) => {
        const result = await transactionClient.appointment.create({
            data: {
                patientId: isPatientExists.id,
                doctorId: isDoctorExists.id,
                doctorScheduleId: isExistsDoctorSchedule.id,
                videoCallingId
            },
            include: {
                doctor: true,
                doctorSchedule: true
            }
        });

        await transactionClient.doctorSchedule.update({
            where: {
                id: isExistsDoctorSchedule.id
            },
            data: {
                isBooked: true
            }
        });

        const transactionId: string = generateTransactionId(result.id);

        await transactionClient.payment.create({
            data: {
                appointmentId: result.id,
                amount: result.doctor.apointmentFee,
                transactionId
            }
        })

        return result;
    });
};

const getMyAppointment = async (
    filters: any,
    options: IPaginationOptions,
    authUser: IAuthUser
): Promise<IGenericResponse<Appointment[]>> => {
    console.log(authUser)
    const { limit, page, skip } = paginationHelpers.calculatePagination(options);
    const andConditions = [];

    if (authUser?.role === UserRole.PATIENT) {
        andConditions.push(
            {
                patient: {
                    email: authUser?.email
                }
            }
        )
    }
    else {
        andConditions.push(
            {
                doctor: {
                    email: authUser?.email
                }
            }
        )
    }
    const whereConditions: Prisma.AppointmentWhereInput =
        andConditions.length > 0 ? { AND: andConditions } : {};

    const result = await prisma.appointment.findMany({
        where: whereConditions,
        skip,
        take: limit,
        orderBy:
            options.sortBy && options.sortOrder
                ? { [options.sortBy]: options.sortOrder }
                : {
                    createdAt: 'desc',
                },
        include: authUser?.role === UserRole.PATIENT
            ? { doctor: true }
            : { patient: true }
    });
    const total = await prisma.appointment.count({
        where: whereConditions
    });

    return {
        meta: {
            total,
            page,
            limit,
        },
        data: result,
    };
};

const getAllFromDB = async (
    filters: any,
    options: IPaginationOptions
): Promise<IGenericResponse<Appointment[]>> => {
    const { limit, page, skip } = paginationHelpers.calculatePagination(options);
    const { searchTerm, ...filterData } = filters;
    const andConditions = [];

    // if (searchTerm) {
    //     andConditions.push({
    //         OR: appointmentSearchableFields.map(field => ({
    //             [field]: {
    //                 contains: searchTerm,
    //                 mode: 'insensitive',
    //             },
    //         })),
    //     });
    // }

    if (Object.keys(filterData).length > 0) {
        andConditions.push({
            AND: Object.keys(filterData).map((key) => {
                if (appointmentRelationalFields.includes(key)) {
                    return {
                        [appointmentRelationalFieldsMapper[key]]: {
                            email: (filterData as any)[key]
                        }
                    };
                } else {
                    return {
                        [key]: {
                            equals: (filterData as any)[key]
                        }
                    };
                }
            })
        });
    }

    // console.dir(andConditions, { depth: Infinity })
    const whereConditions: Prisma.AppointmentWhereInput =
        andConditions.length > 0 ? { AND: andConditions } : {};

    const result = await prisma.appointment.findMany({
        where: whereConditions,
        skip,
        take: limit,
        orderBy:
            options.sortBy && options.sortOrder
                ? { [options.sortBy]: options.sortOrder }
                : {
                    createdAt: 'desc',
                },
        include: {
            doctor: true,
            patient: true
        }
    });
    const total = await prisma.appointment.count({
        where: whereConditions
    });

    return {
        meta: {
            total,
            page,
            limit,
        },
        data: result,
    };
};

const cancelUnpaidAppointments = async () => {
    const thirtyMinutesAgo = new Date(Date.now() - 1 * 60 * 1000);
    const uppaidAppointments = await prisma.appointment.findMany({
        where: {
            paymentStatus: PaymentStatus.UNPAID,
            createdAt: {
                lte: thirtyMinutesAgo
            }
        }
    });
    const appointmentIdsToCancel = uppaidAppointments.map(appointment => appointment.id);
    const scheduleIdsToCancel = uppaidAppointments.map(appointment => appointment.doctorScheduleId);

    await prisma.$transaction(async (transactionClient) => {
        await transactionClient.payment.deleteMany({
            where: {
                appointmentId: {
                    in: appointmentIdsToCancel
                }
            }
        })

        await transactionClient.appointment.deleteMany({
            where: {
                id: {
                    in: appointmentIdsToCancel
                }
            }
        });

        await transactionClient.doctorSchedule.updateMany({
            where: {
                id: {
                    in: scheduleIdsToCancel
                }
            },
            data: {
                isBooked: false
            }
        });
    })
};


export const AppointmentServices = {
    createAppointment,
    getMyAppointment,
    getAllFromDB,
    cancelUnpaidAppointments
};
